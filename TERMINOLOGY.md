# Terminology

This project uses consistent terms across the UI, state, and storage layers.

## Hierarchy (How Things Nest)

- **Session** (`sessionId`)
  - **Model Conversation** (`modelId`)
    - **Run** (`runIndex`, 1-based, optional)
      - **Messages**

In other words, every message is always scoped to a specific **session + model**. Runs are an additional partition _within that model conversation_ when the multiplier is greater than 1.

## Session

A workspace that contains multiple model columns. A session can be renamed, saved to history, loaded, cleared, and exported.

## Model Conversation (Model Column)

The per-model thread inside a session. The UI shows this as a “model column”. It displays that model’s messages and per-model stats.

## Run

A single completion attempt for a model. When the multiplier is greater than 1, the app creates multiple runs (1-based `runIndex`) for the same prompt.

## Message

A single entry in the session thread.

### Identity / Distinguishing Messages

- Every message has: `sessionId` + `modelId`
- Run-scoping:
  - Messages with no `runIndex` are **shared across runs** within that model conversation (typically user/system/tool).
  - Messages with `runIndex` are **specific to that run** (typically assistant).

So to distinguish:

- “session → model conversation” use `modelId`
- “session → model conversation → run 2” use `modelId` + `runIndex === 2` (and include shared messages where `runIndex` is undefined, if you’re rendering a run view)
