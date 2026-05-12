"use strict";
/**
 * embeddings.js — Mnemo embedding layer.
 *
 * Backend: @xenova/transformers (Xenova/all-MiniLM-L6-v2, 384 dim, ONNX)
 * runs in pure JS, no Python, no GPU. ~30MB model auto-downloaded on first use.
 *
 * Provides:
 *   - embedText(text)              -> Float32Array (length 384)
 *   - bufFromVector(vec)           -> Buffer (4*N bytes, little-endian)
 *   - vectorFromBuf(buf)           -> Float32Array
 *   - cosine(a, b)                 -> number in [-1, 1]
 */

const MODEL_NAME = process.env.MNEMO_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
const DIM = 384;
const MODEL_TAG = "all-MiniLM-L6-v2";

let _pipeline = null;
let _loadingPromise = null;

async function getPipeline() {
  if (_pipeline) return _pipeline;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir = process.env.MNEMO_MODEL_CACHE || "/root/mnemo/.models";
    _pipeline = await pipeline("feature-extraction", MODEL_NAME, { quantized: true });
    return _pipeline;
  })();
  return _loadingPromise;
}

async function embedText(text) {
  const pipe = await getPipeline();
  const out = await pipe(text, { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}

function bufFromVector(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function vectorFromBuf(buf) {
  const n = buf.length / 4;
  const vec = new Float32Array(n);
  for (let i = 0; i < n; i++) vec[i] = buf.readFloatLE(i * 4);
  return vec;
}

function cosine(a, b) {
  if (a.length !== b.length) throw new Error("dim mismatch");
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

module.exports = {
  MODEL_TAG, DIM,
  embedText, bufFromVector, vectorFromBuf, cosine,
};
