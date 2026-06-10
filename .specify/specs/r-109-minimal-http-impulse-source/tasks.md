# Tasks: R-109 Minimal HTTP Impulse Source

Branch: `spec/r-109-http-source` · TDD per task.

## T-1: HttpSource core — serve, auth (timingSafeEqual, auth-first), body cap, response contract
## T-2: Per-blueprint token bucket + Retry-After
## T-3: Daemon conditional lifecycle (start when http blueprints exist, stop at zero, reload-aware)
## T-4: Response-code matrix + zero-listener + token-log-absence + perf; gates

## Done gate
- Spec scenarios 1–5; `specflow validate R-109`.
