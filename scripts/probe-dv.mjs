// Throwaway: why does dv.parliament.bg hang for some GitHub runners?
// Tries each address the name resolves to on its own, with plain HTTPS and
// with Chromium, and says which stage stalls. Lives only on the probe branch.
import dns from 'node:dns/promises';
import https from 'node:https';
import { chromium } from 'playwright';

const HOST = 'dv.parliament.bg';
const PATH = '/DVWeb/broeveList.faces';
const URL = `https://${HOST}${PATH}`;
const TIMEOUT_MS = 30000;

function fetchVia(ip) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const at = {};
        const req = https.get(
            { host: ip, servername: HOST, path: PATH, headers: { host: HOST }, timeout: TIMEOUT_MS },
            (res) => {
                at.headers = Date.now() - t0;
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                });
                res.on('end', () =>
                    resolve(`OK   HTTP ${res.statusCode} tcp=${at.tcp}ms tls=${at.tls}ms headers=${at.headers}ms done=${Date.now() - t0}ms ${size}B`),
                );
            },
        );
        req.on('socket', (socket) => {
            socket.on('connect', () => {
                at.tcp = Date.now() - t0;
            });
            socket.on('secureConnect', () => {
                at.tls = Date.now() - t0;
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (err) => {
            const stage = at.headers ? 'body' : at.tls ? 'response' : at.tcp ? 'TLS handshake' : 'TCP connect';
            resolve(`FAIL ${err.message} after ${Date.now() - t0}ms, stalled at ${stage} (tcp=${at.tcp ?? '-'} tls=${at.tls ?? '-'})`);
        });
    });
}

async function chromiumVia(ip) {
    const args = ip ? [`--host-resolver-rules=MAP ${HOST} ${ip}`] : [];
    const browser = await chromium.launch({ headless: true, args });
    const page = await browser.newPage();
    const t0 = Date.now();
    try {
        const res = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
        const rows = await page.locator('text=/Брой \\d+, /').count();
        return `OK   HTTP ${res.status()} in ${Date.now() - t0}ms, ${rows} issue rows`;
    } catch (err) {
        return `FAIL ${err.message.split('\n')[0]} after ${Date.now() - t0}ms`;
    } finally {
        await browser.close();
    }
}

const whoami = await fetch('https://ipinfo.io/json')
    .then((r) => r.json())
    .catch(() => ({}));
console.log(`runner: ${whoami.ip} ${whoami.org} ${whoami.city} ${whoami.country}`);

const ips = await dns.resolve4(HOST);
console.log(`${HOST} A: ${ips.join(', ')}`);
console.log(`${HOST} via OS resolver: ${(await dns.lookup(HOST, { all: true })).map((a) => a.address).join(', ')}`);

for (const ip of ips) console.log(`https    ${ip.padEnd(16)} ${await fetchVia(ip)}`);
for (const ip of [null, ...ips]) console.log(`chromium ${(ip ?? 'default DNS').padEnd(16)} ${await chromiumVia(ip)}`);
