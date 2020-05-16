import { linearBackoff, resolveWaitTime, retry } from '@splunkdlt/async-tasks';
import { createModuleDebug } from '@splunkdlt/debug-logging';
import { AggregateMetric } from '@splunkdlt/stats-collector';
import AbortController from 'abort-controller';
import { default as HttpAgent, HttpOptions, HttpsAgent } from 'agentkeepalive';
import BufferList from 'bl';
import fetch from 'node-fetch';
import { AbortSignal } from 'node-fetch/externals';
import { compressBody } from './compress';
import { CookedHecConfig, HecConfig, parseHecConfig } from './config';
import { SerializedHecMsg, serializeEvent, serializeMetric, serializeMetrics } from './serialize';
import { Event, Metric, MultiMetrics } from './types';
import { deepMerge, removeEmtpyValues, sleep } from './utils';
import { httpClientStats } from './agentstats';

const { debug, info, error, warn } = createModuleDebug('@splunkdlt/hec-client:client');

const initialCounters = {
    errorCount: 0,
    retryCount: 0,
    queuedMessages: 0,
    sentMessages: 0,
    queuedBytes: 0,
    sentBytes: 0,
    transferredBytes: 0,
};

class FlushHandle {
    public promise: Promise<void> | null = null;

    constructor(private abortController: AbortController) {}

    public cancel() {
        this.abortController.abort();
    }
}

export function isMetric(msg: Event | Metric): msg is Metric {
    return 'name' in msg && typeof msg.name !== 'undefined';
}

export class HecClient {
    public readonly config: CookedHecConfig;
    private active: boolean = true;
    private queue: SerializedHecMsg[] = [];
    private queueSizeBytes: number = 0;
    private flushTimer: NodeJS.Timer | null = null;
    private activeFlushing: Set<FlushHandle> = new Set();
    private httpAgent: HttpAgent | HttpsAgent;
    private counters = {
        ...initialCounters,
    };
    private aggregates = {
        requestDuration: new AggregateMetric(),
        batchSize: new AggregateMetric(),
        batchSizeBytes: new AggregateMetric(),
        batchSizeCompressed: new AggregateMetric(),
    };

    public constructor(config: HecConfig) {
        this.config = parseHecConfig(config);
        const agentOptions: HttpOptions = {
            keepAlive: this.config.requestKeepAlive,
            maxSockets: this.config.maxSockets,
            timeout: this.config.timeout,
        };
        this.httpAgent = this.config.url.startsWith('https:')
            ? new HttpsAgent({
                  ...agentOptions,
                  rejectUnauthorized: this.config.validateCertificate,
              } as HttpOptions)
            : new HttpAgent(agentOptions);
    }

    public clone(configOverrides?: Partial<HecConfig>): HecClient {
        debug('Cloning HEC client with overrides %O', configOverrides);
        if (configOverrides == null || Object.keys(removeEmtpyValues(configOverrides)).length === 0) {
            debug('Reusing HEC client for clone without any overrides');
            return this;
        }
        if (configOverrides?.url && configOverrides.url !== this.config.url) {
            debug('Creating new HEC client with different URL', configOverrides.url);
            return new HecClient(deepMerge(this.config, configOverrides || {}));
        }
        debug('Creating new HEC client instance but reusing HTTP agent and socket pool');
        const cloned = new HecClient(deepMerge(this.config, configOverrides || {}));
        cloned.httpAgent = this.httpAgent;
        return cloned;
    }

    public push(msg: Event | Metric) {
        return isMetric(msg) ? this.pushMetric(msg) : this.pushEvent(msg);
    }

    public pushEvent(event: Event) {
        const serialized = serializeEvent(event, this.config.defaultMetadata, this.config.defaultFields);
        this.pushSerializedMsg(serialized);
    }

    public pushMetric(metric: Metric) {
        const serialized = serializeMetric(metric, this.config.defaultMetadata, this.config.defaultFields);
        this.pushSerializedMsg(serialized);
    }

    public pushMetrics(metrics: MultiMetrics) {
        if (this.config.multipleMetricFormatEnabled) {
            const serialized = serializeMetrics(metrics, this.config.defaultMetadata, this.config.defaultFields);
            this.pushSerializedMsg(serialized);
        } else {
            const { measurements, ...rest } = metrics;
            for (const [name, value] of Object.entries(measurements)) {
                if (value != null) {
                    this.pushMetric({
                        ...rest,
                        name,
                        value,
                    });
                }
            }
        }
    }

    private pushSerializedMsg(serialized: SerializedHecMsg) {
        if (!this.active) {
            throw new Error('HEC client has been shut down');
        }
        this.counters.queuedMessages++;
        this.counters.queuedBytes += serialized.length;
        if (this.queueSizeBytes + serialized.length > this.config.maxQueueSize) {
            debug(
                'Flushing HEC queue as size limit would be exceeded by new message (queue size is %s bytes)',
                this.queueSizeBytes
            );
            this.flushInternal();
        }
        this.queueSizeBytes += serialized.length;
        this.queue.push(serialized);
        this.scheduleFlush();
    }

    public async flush(): Promise<void> {
        await Promise.all([...this.activeFlushing.values()].map((f) => f.promise).concat(this.flushInternal()));
    }

    public enableStatsCapture() {
        Object.values(this.aggregates).forEach((agg) => agg.enable());
    }

    public flushStats() {
        const stats = {
            ...this.counters,
            ...this.aggregates.requestDuration.flush('requestDuration'),
            ...this.aggregates.batchSize.flush('batchSize'),
            ...this.aggregates.batchSizeBytes.flush('batchSizeBytes'),
            ...this.aggregates.batchSizeCompressed.flush('batchSizeCompressed'),
            activeFlushingCount: this.activeFlushing.size,
            httpClient: httpClientStats(this.httpAgent.getCurrentStatus()),
            queueSize: this.queue.length,
            queueSizeBytes: this.queueSizeBytes,
        };
        this.counters = { ...initialCounters };
        return stats;
    }

    public async shutdown(maxTime?: number) {
        info('Shutting down HEC client');
        this.active = false;
        if (maxTime != null && (this.activeFlushing.size > 0 || this.queue.length > 0)) {
            debug(`Waiting for ${this.activeFlushing.size} flush tasks to complete`);
            await Promise.race([sleep(maxTime), this.flush()]);
        }
        if (this.activeFlushing.size > 0) {
            debug(`Cancelling ${this.activeFlushing.size} flush tasks`);
            this.activeFlushing.forEach((f) => f.cancel());
        }
    }

    public async checkAvailable(): Promise<void> {
        const url = new URL(this.config.url);
        url.pathname = '/services/collector/health';

        debug('Checking if HEC is available at %s', url.href);
        try {
            const res = await fetch(url.href, {
                method: 'GET',
                headers: {
                    'User-Agent': this.config.userAgent,
                },
                agent: this.httpAgent,
                timeout: this.config.timeout,
            });
            debug('HEC responded to availability check with HTTP status %d', res.status);
            if (!res.ok) {
                throw new Error(`HTTP Status ${res.status}`);
            }
            const data = await res.json();

            debug('Received availability check response: %o', data);
        } catch (e) {
            debug('HEC availability check failed', e);
            throw e;
        }
    }

    public async waitUntilAvailable(maxTime: number = 20_000) {
        const startTime = Date.now();
        debug('Checking HEC service %s availability (timeout %d ms)', this.config.url, maxTime);
        let checkFailedOnce = false;
        await retry(
            () =>
                this.checkAvailable().catch((e) =>
                    Promise.reject(`HEC service ${this.config.url} not available: ${e.toString()}`)
                ),
            {
                taskName: 'HEC availablility',
                waitBetween: linearBackoff({ min: 500, step: 250, max: 2500 }),
                timeout: maxTime,
                onError: (e) => {
                    if (!checkFailedOnce) {
                        warn('HEC service not (yet) available:', e);
                        info(
                            'Waiting for HEC service %s to become available (timeout %d ms)',
                            this.config.url,
                            maxTime
                        );
                        checkFailedOnce = true;
                    }
                },
            }
        );
        if (checkFailedOnce) {
            info('HEC service is now available after %d ms', Date.now() - startTime);
        }
    }

    private flushInternal = (): Promise<void> => {
        if (this.flushTimer != null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.queue.length === 0) {
            return Promise.resolve();
        }
        const queue = this.queue;
        this.queue = [];
        this.queueSizeBytes = 0;

        const abortController = new AbortController();
        const flushHandle = new FlushHandle(abortController);
        const flushCompletePromise = this.sendToHec(queue, abortController.signal);
        flushHandle.promise = flushCompletePromise;
        this.activeFlushing.add(flushHandle);

        const removeFromActive = () => this.activeFlushing.delete(flushHandle);
        flushCompletePromise.then(removeFromActive, removeFromActive);

        return flushCompletePromise;
    };

    private async sendToHec(msgs: SerializedHecMsg[], abortSignal: AbortSignal): Promise<void> {
        const startTime = Date.now();
        debug('Flushing HEC queue with %s messages', msgs.length);
        const rawBody = new BufferList(msgs);
        const rawBodySize = rawBody.length;
        const body = this.config.gzip ? await compressBody(rawBody) : rawBody;
        const bodySize = body.length;
        this.aggregates.batchSize.push(msgs.length);
        this.aggregates.batchSizeBytes.push(rawBodySize);
        if (this.config.gzip) {
            this.aggregates.batchSizeCompressed.push(bodySize);
        }
        const headers: { [k: string]: string } = {
            'Content-Length': String(bodySize),
            'User-Agent': this.config.userAgent,
        };
        if (this.config.token !== null) {
            headers['Authorization'] = `Splunk ${this.config.token}`;
        }
        if (this.config.gzip) {
            headers['Content-Encoding'] = 'gzip';
        }
        let attempt = 0;

        while (true) {
            attempt++;
            try {
                const requestStart = Date.now();
                const response = await fetch(this.config.url, {
                    method: 'POST',
                    headers,
                    body: body.duplicate(),
                    agent: this.httpAgent,
                    signal: abortSignal,
                    timeout: this.config.timeout,
                });
                this.aggregates.requestDuration.push(Date.now() - requestStart);

                if (!response.ok) {
                    if (debug.enabled) {
                        try {
                            const text = await response.text();
                            debug(`Response from HEC: %s`, text);
                        } catch (e) {
                            debug('Failed to retrieve text from HEC response', e);
                        }
                    }
                    throw new Error(`HEC responded with status ${response.status}`);
                }

                debug(
                    'Successfully flushed %s HEC messages in %s attempts and %s ms',
                    msgs.length,
                    attempt,
                    Date.now() - startTime
                );

                this.counters.sentMessages += msgs.length;
                this.counters.sentBytes += rawBodySize;
                this.counters.transferredBytes += bodySize;
                break;
            } catch (e) {
                this.counters.errorCount++;
                debug('Failed to send batch to HEC (attempt %s)', attempt, e);
                error('Failed to send batch to HEC (attempt %s): %s', attempt, e.toString());
                if (abortSignal.aborted) {
                    throw new Error('Aborted');
                }
                if (attempt <= this.config.maxRetries) {
                    const retryDelay = resolveWaitTime(this.config.retryWaitTime, attempt);
                    debug(`Retrying to send batch to HEC in %d ms`, retryDelay);
                    await sleep(retryDelay);
                    if (abortSignal.aborted) {
                        throw new Error('Aborted');
                    }
                    this.counters.retryCount++;
                }
            }
        }
    }

    private scheduleFlush() {
        if (this.config.maxQueueEntries !== -1 && this.queue.length > this.config.maxQueueEntries) {
            debug('Flushing HEC queue for entries limit being reached (%s entries)', this.queue.length);
            this.flushInternal();
            return;
        }
        if (this.flushTimer == null) {
            this.flushTimer = setTimeout(() => {
                debug('Flushing HEC queue for time limit being reached');
                this.flushInternal();
            }, this.config.flushTime ?? 0);
        }
    }
}
