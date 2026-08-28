const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const allowedEmailDomains = new Set([
  'example.com',
  'example.invalid',
  'users.noreply.github.com',
]);
const allowedEmailValues = new Set(['git@github.com', 'noreply@github.com']);
const blockedFileNames = [
  /^\.env(?:\..+)?$/i,
  /^auth\.json$/i,
  /^credentials?(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];
const blockedContent = [
  { rule: 'PRIVATE_KEY_BLOCK', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { rule: 'GITHUB_TOKEN', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { rule: 'AWS_ACCESS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'ABSOLUTE_WINDOWS_HOME', pattern: /[A-Za-z]:\\Users\\[^\\\r\n]+\\/i },
  { rule: 'ABSOLUTE_MACOS_HOME', pattern: /\/Users\/[^/\r\n]+\// },
  { rule: 'ABSOLUTE_LINUX_HOME', pattern: /\/home\/[^/\r\n]+\// },
];

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
}

function isAllowedEmail(value) {
  const normalized = value.toLowerCase();
  if (allowedEmailValues.has(normalized)) return true;
  const at = normalized.lastIndexOf('@');
  return at > 0 && allowedEmailDomains.has(normalized.slice(at + 1));
}

function inspectText(text, location, findings) {
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  for (const email of emails) {
    if (!isAllowedEmail(email)) findings.push({ rule: 'ROUTABLE_EMAIL', location });
  }
  for (const check of blockedContent) {
    if (check.pattern.test(text)) findings.push({ rule: check.rule, location });
  }
}

function main() {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const tracked = git(['ls-files', '-z'], { cwd: root, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const findings = [];

  for (const relative of tracked) {
    const normalized = relative.replaceAll('\\', '/');
    const base = path.posix.basename(normalized);
    if (blockedFileNames.some((pattern) => pattern.test(base))) {
      findings.push({ rule: 'CREDENTIAL_FILE', location: normalized });
    }
    inspectText(normalized, `filename:${normalized}`, findings);
    const absolute = path.join(root, ...normalized.split('/'));
    const data = fs.readFileSync(absolute);
    if (!data.includes(0)) inspectText(data.toString('utf8'), normalized, findings);
  }

  const records = git([
    'log',
    '--all',
    '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e',
  ], { cwd: root });
  for (const record of records.split('\x1e')) {
    if (!record.trim()) continue;
    const fields = record.split('\0');
    if (fields.length < 6) {
      findings.push({ rule: 'MALFORMED_GIT_METADATA', location: 'git-history' });
      continue;
    }
    const [commit, , authorEmail, , committerEmail, message] = fields;
    if (!isAllowedEmail(authorEmail.trim())) {
      findings.push({ rule: 'GIT_AUTHOR_EMAIL', location: `commit:${commit}` });
    }
    if (!isAllowedEmail(committerEmail.trim())) {
      findings.push({ rule: 'GIT_COMMITTER_EMAIL', location: `commit:${commit}` });
    }
    inspectText(message, `commit-message:${commit}`, findings);
  }

  const unique = [...new Map(findings.map((item) => [`${item.rule}\0${item.location}`, item])).values()];
  if (unique.length > 0) {
    console.error(JSON.stringify({ pass: false, findingCount: unique.length, findings: unique }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ pass: true, trackedFiles: tracked.length, commitsChecked: records.split('\x1e').filter((value) => value.trim()).length }));
}

main();
