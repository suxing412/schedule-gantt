'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const sourcePath = process.env.SCHEDULE_TEST_HTML || path.join(__dirname, '..', 'index.html');
const source = fs.readFileSync(sourcePath, 'utf8');
const colorStart = source.indexOf('function lumOf(');
const colorEnd = source.indexOf('function darkenCol(', colorStart);
assert.ok(colorStart >= 0 && colorEnd > colorStart, 'Color helpers must be available');
const context = vm.createContext({});
vm.runInContext(source.slice(colorStart, colorEnd) + '\nglobalThis.colorApi={lumOf,barTextCol,barProgressCol};', context);
const { lumOf, barTextCol, barProgressCol } = context.colorApi;

// Independent WCAG contrast calculation, including the composited progress fill.
function channels(hex) {
  let value = hex.slice(1);
  if (value.length === 3) value = value.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
}
function luminance(rgb) {
  const linear = rgb.map(value => value / 255).map(value =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(fg, bg) {
  const a = luminance(typeof fg === 'string' ? channels(fg) : fg);
  const b = luminance(typeof bg === 'string' ? channels(bg) : bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function composite(fill, bg) {
  const match = fill.match(/^rgba\((\d+),(\d+),(\d+),([.\d]+)\)$/);
  assert.ok(match, 'Progress fill must provide a usable transparent color');
  const alpha = Number(match[4]);
  return channels(bg).map((value, i) => value * (1 - alpha) + Number(match[i + 1]) * alpha);
}
function hex(rgb) { return '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join(''); }

const backgrounds = new Set(['#2f6fe8', '#ec4899', '#0ea5e9', '#a855f7', '#575ae8', '#f59e0b']);
for (let value = 0; value <= 255; value++) backgrounds.add(hex([value, value, value]));
for (let r = 0; r <= 255; r += 17) {
  for (let g = 0; g <= 255; g += 17) {
    for (let b = 0; b <= 255; b += 17) backgrounds.add(hex([r, g, b]));
  }
}

test('task names meet small-text contrast on role and custom colors', () => {
  for (const bg of backgrounds) {
    const fg = barTextCol(bg);
    assert.ok(contrast(fg, bg) >= 4.5, `${fg} on ${bg} must reach 4.5:1`);
  }
});

test('task progress preserves contrast on both sides of the completion boundary', () => {
  for (const bg of backgrounds) {
    const fg = barTextCol(bg);
    const base = contrast(fg, bg);
    const completed = contrast(fg, composite(barProgressCol(bg), bg));
    assert.ok(completed >= 4.5, `Completed area of ${bg} must remain readable`);
    assert.ok(completed >= base - 1e-12, `Progress on ${bg} must not weaken name contrast`);
  }
});

test('color helpers accept shorthand and uppercase hexadecimal colors', () => {
  for (const [short, full] of [['#abc', '#aabbcc'], ['#F05', '#ff0055'], ['#FFF', '#ffffff']]) {
    assert.ok(Math.abs(lumOf(short) - luminance(channels(full))) < 1e-12);
    assert.equal(barTextCol(short), barTextCol(full));
    assert.equal(barProgressCol(short), barProgressCol(full));
  }
});

test('primary buttons and selected blue text meet small-text contrast', () => {
  const token = name => {
    const match = source.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i'));
    assert.ok(match, `${name} token must exist`);
    return match[1];
  };
  const primaryRule = source.match(/\.btn\.primary\s*\{([^}]+)\}/);
  assert.ok(primaryRule);
  const primaryBackground = primaryRule[1].match(/background:\s*var\(--([\w-]+)\)/);
  assert.ok(primaryBackground);
  assert.ok(contrast('#ffffff', token(primaryBackground[1])) >= 4.5);
  for (const bg of ['#ffffff', '#e8f0ff', '#dbe7ff']) {
    assert.ok(contrast(token('accent-strong'), bg) >= 4.5, `Selected blue text on ${bg}`);
  }
});
