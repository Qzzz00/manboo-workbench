#!/usr/bin/env node
'use strict';

/**
 * One-off bridge: convert assets/stickers/labels.json from the legacy
 * feature/sticker-system format into the main v2 schema.
 *
 * Input may contain:
 *   sticker_id, filename, cdn_url, sticker_type,
 *   emotion_tags[], meme_tags[], scene_tags[],
 *   meme_explanation, source_note
 *
 * Output guarantees all original fields are preserved, plus:
 *   vibe_tags[]  = emotion_tags + meme_tags + scene_tags, deduplicated, order kept
 *   description  = meme_explanation || source_note || ''
 *
 * Idempotent: safe to run multiple times. Existing non-empty vibe_tags/description
 * are kept so the script does not overwrite hand-tuned v2 data.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LABELS_PATH = path.join(PROJECT_ROOT, 'assets', 'stickers', 'labels.json');

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function mergeUniqueTags(...lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const tag = String(item);
      if (!seen.has(tag)) {
        seen.add(tag);
        result.push(tag);
      }
    }
  }
  return result;
}

function buildDescription(label) {
  if (isNonEmptyString(label.meme_explanation)) return label.meme_explanation.trim();
  if (isNonEmptyString(label.source_note)) return label.source_note.trim();
  return '';
}

function convertLabel(label) {
  const out = { ...label };

  if (!isNonEmptyArray(out.vibe_tags)) {
    out.vibe_tags = mergeUniqueTags(out.emotion_tags, out.meme_tags, out.scene_tags);
  }

  if (!isNonEmptyString(out.description)) {
    out.description = buildDescription(out);
  }

  return out;
}

function readLabels(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`labels.json not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('labels.json must be an array');
  }
  return parsed;
}

function writeLabels(filePath, labels) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

function main() {
  const labels = readLabels(LABELS_PATH);
  const converted = labels.map(convertLabel);

  const missingVibe = converted.filter((l) => !isNonEmptyArray(l.vibe_tags));
  const missingDesc = converted.filter((l) => !isNonEmptyString(l.description));

  if (missingVibe.length > 0) {
    console.warn(`[bridge] ${missingVibe.length} sticker(s) still lack vibe_tags after conversion`);
  }
  if (missingDesc.length > 0) {
    console.warn(`[bridge] ${missingDesc.length} sticker(s) still lack description after conversion`);
  }

  writeLabels(LABELS_PATH, converted);
  console.log(`[bridge] converted ${converted.length} sticker label(s)`);
  console.log(`[bridge] wrote ${LABELS_PATH}`);
}

if (require.main === module) {
  main();
}

module.exports = { convertLabel, mergeUniqueTags, buildDescription };
