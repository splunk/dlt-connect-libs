# @splunkdlt/prometheus-metrics

Utility to help scrape metrics from apps exposing prometheus-style metrics endpoints.

## Example Usage

<!-- EXAMPLE:simple-scraper:START -->

```typescript
while (running) {
    const scrapeResult = await scrapePrometheusMetrics({
        url: 'http://localhost:8080/debug/metrics/prometheus',
    });

    const convertedMetrics = convertToHecMultiMetrics(scrapeResult.metrics, {
        captureTimestamp: Date.now(),
        namePrefix: 'geth',
        metadata: {
            host: os.hostname(),
            source: 'geth:metrics:prometheus',
        },
    });

    for (const hecMetrics of convertedMetrics) {
        hec.pushMetrics(hecMetrics);
    }

    await sleep(5_000);
}
```

<!-- EXAMPLE:simple-scraper:END -->
