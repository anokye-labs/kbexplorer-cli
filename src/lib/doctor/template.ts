import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { readSourceRecord, SOURCE_FILE, classifyRef } from '../source.ts';
import { getSubmoduleUrl } from '../detect-repo.ts';

function pass(id, message) { return { id, status: 'pass', message }; }
function warn(id, message) { return { id, status: 'warn', message }; }
function fail(id, message) { return { id, status: 'fail', message }; }

export function checkTemplate({ cwd, offline, getLatestTag: getLatestTagImpl }) {
  const checks = [];

  const sourceFilePath = resolve(cwd, SOURCE_FILE);
  if (!existsSync(sourceFilePath)) {
    checks.push(warn('template.source-record', `${SOURCE_FILE} not found — run kbx init to create it`));
    return checks;
  }

  const record = readSourceRecord(cwd);
  if (!record) {
    checks.push(fail('template.source-record', `${SOURCE_FILE} exists but could not be parsed`));
    return checks;
  }

  checks.push(pass('template.source-record', `${SOURCE_FILE} present (mode: ${record.mode ?? 'unknown'}, template: ${record.template ?? 'unknown'})`));

  if (record.mode === 'submodule') {
    const gmUrl = getSubmoduleUrl(cwd);
    if (!gmUrl) {
      checks.push(warn('template.gitmodules', '.gitmodules not found or does not contain a .kbx entry'));
    } else if (record.template && gmUrl !== record.template) {
      checks.push(warn('template.gitmodules', `.gitmodules url (${gmUrl}) differs from ${SOURCE_FILE} template (${record.template}) — reconcile to avoid updating from the wrong remote`));
    } else {
      checks.push(pass('template.gitmodules', `.gitmodules url agrees with ${SOURCE_FILE}`));
    }
  }

  const refType = record.refType || classifyRef(record.ref);
  if (refType === 'tag') {
    checks.push(pass('template.ref', `Template pinned to tag: ${record.ref}`));
    if (!offline && getLatestTagImpl && record.template) {
      try {
        const latest = getLatestTagImpl(record.template);
        if (latest && latest !== record.ref) {
          checks.push(warn('template.latest', `A newer release tag exists: ${record.ref} → ${latest} (run kbx update)`));
        } else if (latest) {
          checks.push(pass('template.latest', `Template is on the latest release tag (${latest})`));
        }
      } catch {
        checks.push(warn('template.latest', 'Could not fetch latest tag from remote (network unavailable?)'));
      }
    } else if (offline) {
      checks.push(warn('template.latest', 'Latest tag check skipped (--offline)'));
    }
  } else if (refType === 'branch') {
    checks.push(warn('template.ref', `Template tracks branch "${record.ref}" — consider pinning to a release tag for reproducibility`));
  } else {
    checks.push(pass('template.ref', 'Template tracking latest release'));
    if (!offline && getLatestTagImpl && record.template) {
      try {
        const latest = getLatestTagImpl(record.template);
        if (latest) {
          checks.push(pass('template.latest', `Latest release tag: ${latest}`));
        } else {
          checks.push(warn('template.latest', 'Could not determine latest release tag'));
        }
      } catch {
        checks.push(warn('template.latest', 'Could not fetch latest tag from remote (network unavailable?)'));
      }
    } else if (offline) {
      checks.push(warn('template.latest', 'Latest tag check skipped (--offline)'));
    }
  }

  return checks;
}
