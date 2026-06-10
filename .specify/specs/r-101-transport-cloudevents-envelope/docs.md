# Documentation Updates — R-101: Transport + CloudEvents envelope

Generated: 2026-06-10

## CHANGELOG

Entry added to CHANGELOG.md:
> - **R-101 Transport + CloudEvents envelope**: **Core Problem:** Every downstream Reflex feature (decision pipeline R-104, CLI R-107, bus impulses R-108) needs publish/subscribe, request/reply, and a validated envelope. Building a reflex-local ...

## User-Facing Changes

### CLI Changes
- ----
- -------------
- --------
- ----------
- -------------------
- ---
- --noEmit

## README Update

The following README updates are suggested:

## Stack

TypeScript + Bun · NATS JetStream via [`@the-metafactory/myelin`](https://github.com/the-metafactory/myelin) · SQLite + Drizzle · zod

## Transport

Reflex consumes myelin (git-pinned) for all bus operations — no reflex-local transport. Wire format: `MyelinEnvelope` (supersedes earlier CloudEvents/DD-68 framing). Same pattern as cortex, grove, sage, pilot.

Credentials: `~/.config/nats/creds/reflex.creds` (DD-72).
