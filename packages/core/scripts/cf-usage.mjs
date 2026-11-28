#!/usr/bin/env node
/**
 * What Cloudflare counted for your containers in a time window, and what that costs at list price.
 * Reads the GraphQL Analytics dataset `containersUsageAdaptiveGroups`, the one whose daily totals match the bill.
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *     node packages/core/scripts/cf-usage.mjs --since 2026-11-28T10:00:00Z --until 2026-11-28T10:30:00Z [--app <application id>] [--by-minute]
 *
 * The token needs "Account Analytics: Read". --app is the ID column of `npx wrangler containers list`; without it the
 * whole account is summed, so nothing else should run in the window. Usage arrives a few minutes late: query a window
 * that ended at least 5 minutes ago.
 *
 * Prices (https://developers.cloudflare.com/containers/pricing/, read 2026-11-28; the monthly allowances of the
 * Workers Paid plan are NOT subtracted): $0.000020 per vCPU-second of CPU used, $0.0000025 per GiB-second of memory and
 * $0.00000007 per GB-second of disk provisioned while an instance runs, $0.025 per GB of egress (North America and
 * Europe; 0.04 or 0.05 elsewhere: --egress-price).
 */
const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith('--') ? [arg.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? true : all[index + 1]] : null).filter(Boolean));
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account || !args.since) {
  console.error('usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... cf-usage.mjs --since <ISO time> [--until <ISO time>] [--app <application id>] [--by-minute] [--egress-price 0.025]');
  process.exit(2);
}
// `wrangler containers list` prints the ID without dashes; the dataset has it as a UUID with dashes.
const dashed = (id) => (/^[0-9a-f]{32}$/i.test(id) ? id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : id);
const until = args.until ?? new Date().toISOString();
const filter = { datetimeMinute_geq: new Date(args.since).toISOString().replace('.000Z', 'Z'), datetimeMinute_lt: new Date(until).toISOString().replace('.000Z', 'Z'), ...(args.app ? { applicationId: dashed(String(args.app)) } : {}) };
const query = `query ($account: string!, $filter: AccountContainersUsageAdaptiveGroupsFilter_InputObject!) {
  viewer { accounts(filter: { accountTag: $account }) {
    containersUsageAdaptiveGroups(limit: 10000, filter: $filter, orderBy: [datetimeMinute_ASC]) {
      sum { cpuTimeSec allocatedMemory allocatedDisk txBytes } dimensions { datetimeMinute }
    } } } }`;
const response = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { account, filter } }) });
const body = await response.json();
if (!response.ok || body.errors?.length) { console.error(JSON.stringify(body.errors ?? body).slice(0, 1000)); process.exit(1); }
const rows = body.data.viewer.accounts[0]?.containersUsageAdaptiveGroups ?? [];

const egressPrice = Number(args['egress-price'] ?? 0.025);
// allocatedMemory and allocatedDisk are byte-seconds: memory is priced per GiB, disk per GB.
const costOf = (sum) => {
  const memoryGiBs = sum.allocatedMemory / 2 ** 30;
  const diskGBs = sum.allocatedDisk / 1e9;
  const egressGB = sum.txBytes / 1e9;
  const parts = { cpu: sum.cpuTimeSec * 0.00002, memory: memoryGiBs * 0.0000025, disk: diskGBs * 0.00000007, egress: egressGB * egressPrice };
  return { cpuSeconds: sum.cpuTimeSec, memoryGiBSeconds: memoryGiBs, diskGBSeconds: diskGBs, egressBytes: sum.txBytes, usd: { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) } };
};
const total = rows.reduce((acc, row) => { for (const key of Object.keys(acc)) acc[key] += row.sum[key] ?? 0; return acc; }, { cpuTimeSec: 0, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 });
const round = (value) => (typeof value === 'number' ? Number(value.toPrecision(6)) : value);
const tidy = (object) => JSON.parse(JSON.stringify(object, (key, value) => round(value)));
if (args['by-minute']) for (const row of rows) console.log(row.dimensions.datetimeMinute, JSON.stringify(tidy(costOf(row.sum))));
console.log(JSON.stringify({ since: filter.datetimeMinute_geq, until: filter.datetimeMinute_lt, minutes: rows.length, ...tidy(costOf(total)) }, null, 2));
