"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { uncoveredRects, intersect } = require("../core.js");
const viewport = { left: 0, top: 0, right: 100, bottom: 100 };
test("popup clipping keeps only the background outside the popup", () => {
  const popup = { left: 30, top: 20, right: 70, bottom: 80 }, pieces = uncoveredRects(viewport, [popup]);
  assert.equal(pieces.length, 4);
  assert.equal(pieces.reduce((area, piece) => area + (piece.right - piece.left) * (piece.bottom - piece.top), 0), 7600);
  for (const piece of pieces) assert.equal(intersect(piece, popup), null);
});
test("overlapping and nested popup masks never expose their shared area", () => {
  const blockers = [{ left: 20, top: 20, right: 60, bottom: 60 }, { left: 40, top: 40, right: 80, bottom: 80 }, { left: 45, top: 45, right: 55, bottom: 55 }];
  const pieces = uncoveredRects(viewport, blockers);
  assert.equal(pieces.reduce((area, piece) => area + (piece.right - piece.left) * (piece.bottom - piece.top), 0), 7200);
  for (const piece of pieces) for (const blocker of blockers) assert.equal(intersect(piece, blocker), null);
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) assert.equal(intersect(pieces[i], pieces[j]), null);
});
test("closed/offscreen popups leave the background intact and full-screen popups hide it", () => {
  assert.deepEqual(uncoveredRects(viewport, []), [viewport]);
  assert.deepEqual(uncoveredRects(viewport, [{ left: 200, top: 200, right: 300, bottom: 300 }]), [viewport]);
  assert.deepEqual(uncoveredRects(viewport, [{ left: -10, top: -10, right: 110, bottom: 110 }]), []);
  const partial = uncoveredRects(viewport, [{ left: -10, top: 0, right: 40, bottom: 200 }]);
  assert.deepEqual(partial, [{ left: 40, top: 0, right: 100, bottom: 100 }]);
});
