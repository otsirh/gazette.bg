// Whether a site lets AI use its content, read from its robots.txt: a site
// that shuts out Anthropic's agents, or says ai-input=no in a Content-Signal
// line, is not read at all. Its wish is the rule, not whether we could.

const ANTHROPIC = /^(claudebot|claude-user|claude-web|claude-searchbot|anthropic-ai)$/i;

export function aiRefused(robots) {
    if (/content-signal:[^\n]*ai-input\s*=\s*no/i.test(robots)) return true;
    let agents = [];
    let inRules = false;
    for (const raw of String(robots).split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) continue;
        const i = line.indexOf(':');
        if (i < 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const val = line.slice(i + 1).trim();
        if (key === 'user-agent') {
            if (inRules) agents = [];
            inRules = false;
            agents.push(val);
        } else if (key === 'disallow' || key === 'allow') {
            inRules = true;
            if (key === 'disallow' && val === '/' && agents.some((a) => ANTHROPIC.test(a))) return true;
        }
    }
    return false;
}
