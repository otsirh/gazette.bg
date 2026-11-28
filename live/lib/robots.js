// Whether a site lets AI use its content, from what it publishes for
// machines: robots.txt (Anthropic's agents, or everyone), a Content-Signal
// ai-input=no line, and a TDM reservation in /.well-known/tdmrep.json
// (the W3C TDMRep protocol, which ЗАПСП чл. 26е(4) recognises as a
// machine-readable opt-out). The site's wish is the rule.

const ANTHROPIC = /^(claudebot|claude-user|claude-web|claude-searchbot|anthropic-ai)$/i;

// robots.txt as groups of { agents, rules: [[allow|disallow, path]] }.
export function parseRobots(text) {
    const groups = [];
    let cur = null;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        const i = line.indexOf(':');
        if (!line || i < 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const val = line.slice(i + 1).trim();
        if (key === 'user-agent') {
            // Consecutive user-agent lines share a group; any other line
            // (a rule, Crawl-delay, Sitemap) ends the list of agents.
            if (!cur || cur.closed) {
                cur = { agents: [], rules: [], closed: false };
                groups.push(cur);
            }
            cur.agents.push(val);
        } else {
            if (cur) cur.closed = true;
            if ((key === 'disallow' || key === 'allow') && cur) cur.rules.push([key, val]);
        }
    }
    return groups;
}

// The groups that apply to us: every group naming one of Anthropic's agents,
// and the group for everyone. A path is ours to read only if none of them
// forbids it: a site that welcomes Claude-User but shuts out ClaudeBot has
// said no.
function ourGroups(groups) {
    return groups.filter((g) => g.agents.some((a) => ANTHROPIC.test(a) || a === '*'));
}

function matches(rule, path) {
    if (!rule) return false;
    const pattern = rule
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$/, '$');
    return new RegExp(`^${pattern}`).test(path);
}

// Within one group the longest matching rule wins, and allow wins a tie
// (RFC 9309).
function groupAllows(g, path) {
    let best = null;
    for (const [kind, rule] of g.rules) {
        if (kind === 'disallow' && !rule) continue;
        if (!matches(rule, path)) continue;
        if (!best || rule.length > best[1].length || (rule.length === best[1].length && kind === 'allow'))
            best = [kind, rule];
    }
    return !best || best[0] === 'allow';
}

export function pathAllowed(robots, path) {
    return ourGroups(parseRobots(robots)).every((g) => groupAllows(g, path));
}

// The whole site refuses AI: ai-input=no, or "Disallow: /" for us.
export function aiRefused(robots) {
    if (/content-signal:[^\n]*ai-input\s*=\s*no/i.test(robots)) return true;
    return !pathAllowed(robots, '/');
}

// A TDM reservation covering this path, from tdmrep.json.
export function tdmReserved(tdmrep, path) {
    let rules;
    try {
        rules = JSON.parse(tdmrep);
    } catch {
        return false;
    }
    if (!Array.isArray(rules)) return false;
    return rules.some(
        (r) => Number(r?.['tdm-reservation']) === 1 && matches(String(r.location ?? '').replace(/^\/?/, '/'), path),
    );
}
