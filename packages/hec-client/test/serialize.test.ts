import { serializeTime, serializeEvent, serializeMetric, serializeMetrics } from '../src/serialize';

test('serializeTime', () => {
    expect(serializeTime(new Date('2019-11-29T12:15:27.123Z'))).toMatchInlineSnapshot(`1575029727.123`);
    expect(serializeTime(1575029727123)).toMatchInlineSnapshot(`1575029727.123`);
});

test('serializeEvent', () => {
    expect(
        JSON.parse(
            serializeEvent({
                body: 'hello world',
                time: new Date('2019-11-29T12:15:27.123Z'),
                metadata: {
                    host: 'myhost',
                    source: 'somesource',
                    sourcetype: 'somesourcetype',
                    index: 'myindex',
                },
            }).toString('utf8')
        )
    ).toMatchInlineSnapshot(`
        Object {
          "event": "hello world",
          "fields": Object {},
          "host": "myhost",
          "index": "myindex",
          "source": "somesource",
          "sourcetype": "somesourcetype",
          "time": 1575029727.123,
        }
    `);
});

test('serializeMetric', () => {
    expect(
        JSON.parse(
            serializeMetric({
                time: new Date('2019-11-29T12:15:27.123Z'),
                name: 'mymetric',
                value: 47.11,
                metadata: {
                    host: 'myhost',
                    source: 'somesource',
                    sourcetype: 'somesourcetype',
                    index: 'myindex',
                },
            }).toString('utf8')
        )
    ).toMatchInlineSnapshot(`
        Object {
          "fields": Object {
            "_value": 47.11,
            "metric_name": "mymetric",
          },
          "host": "myhost",
          "index": "myindex",
          "source": "somesource",
          "sourcetype": "somesourcetype",
          "time": 1575029727.123,
        }
    `);
});

test('serializeMetrics', () => {
    expect(
        JSON.parse(
            serializeMetrics({
                time: new Date('2019-11-29T12:15:27.123Z'),
                measurements: {
                    'ethlogger.internal.system.cpu.user': 47.11,
                    'ethlogger.internal.system.cpu.system': 8.15,
                },
                fields: {
                    pid: 3158,
                    version: '1.0.0',
                    nodeVersoin: '12.3.1',
                },
                metadata: {
                    host: 'myhost',
                    source: 'somesource',
                    sourcetype: 'somesourcetype',
                    index: 'myindex',
                },
            }).toString('utf-8')
        )
    ).toMatchInlineSnapshot(`
        Object {
          "fields": Object {
            "metric_name:ethlogger.internal.system.cpu.system": 8.15,
            "metric_name:ethlogger.internal.system.cpu.user": 47.11,
            "nodeVersoin": "12.3.1",
            "pid": 3158,
            "version": "1.0.0",
          },
          "host": "myhost",
          "index": "myindex",
          "source": "somesource",
          "sourcetype": "somesourcetype",
          "time": 1575029727.123,
        }
    `);
});
