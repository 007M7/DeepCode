# Agent Note: One carrier-level browser-trust boundary for the whole /api surface

Status: implemented

English | [中文](2026-07-28-api-browser-trust-boundary.zh.md)

## Problem

The web GUI host serves `/api` over plain HTTP (default `127.0.0.1:3080`, `--host 0.0.0.0` supported), and the surface includes remote-code-execution-grade methods — `session.prompt` drives an agent that runs bash. A browser turns the operator into a confused deputy against such a local API in two classic ways: a malicious page fires a "simple" cross-site POST (`text/plain` — sent without a CORS preflight) whose side effects execute even though the response stays unreadable, and a DNS-rebound origin talks to the socket as if same-origin, making CORS inapplicable entirely, with only the `Host` header betraying the attacker's domain. Before this decision the system's only browser-trust check (`isTrustedNativeDialogRequest`: loopback socket + same-origin + loopback Host) guarded exactly one cosmetic route — `host.pickDirectory`, whose native dialog pops on the host's screen — while every consequential method was unguarded. Guarding per-RPC also could not survive the upcoming in-app directory browser, whose whole point is serving legitimately remote clients that a loopback rule would refuse.

## Decision

Enforce browser trust once, at the carrier, for the entire `/api` prefix — two halves in two stacked PRs:

- **Media-type fence (dsh-host-apiproxy)**: every `/api` POST must declare `application/json`, else 415 before parsing. Cross-site "simple" requests thereby stop existing: any cross-site attempt is forced into a CORS preflight this server never answers.
- **Authority fence (dsh-client-connection, `src/api-request-trust.ts`)**: `Host` must be loopback or an exact `host[:port]` from the plugin's `trustedHosts` config (rebinding defense); an attached `Origin` must equal that authority; `sec-fetch-site: cross-site` is refused outright. Requests without browser markers pass — a non-browser client is the principal itself, not a deputy. `host.pickDirectory` loses its bespoke guard and rides the same fence.

Two boundaries stay deliberately out of scope: reachability is the webserver binding's policy (`host: 127.0.0.1 | 0.0.0.0`), and authentication for genuinely remote deployments is deferred work recorded in the connection README — the fence is a confused-deputy defense, not an auth layer. The old guard's loopback-socket check was dropped rather than generalized: with binding expressing reachability and `trustedHosts` naming remote authorities, the socket address adds nothing a header fence does not already cover.

## Alternatives considered

- **Per-RPC guards (status quo extended).** Rejected: the guard list trails the method list forever, the highest-value methods were already unguarded, and a loopback rule on browse RPCs would break the remote deployments they exist for.
- **CORS headers + credential omission.** Rejected: we never want cross-origin reads at all, so answering preflights only widens the surface; refusing them is strictly stronger and simpler.
- **Auth tokens now.** Rejected for this change: token minting/storage/rotation is real product surface; the fence closes the browser-deputy holes today without pre-deciding the auth design.

## Consequences

- Any future `/api` method is covered by construction; there is no per-route trust decision left to forget.
- Non-loopback deployments must declare their serving authorities in `trustedHosts` or browsers are refused; plain curl-shape automation is unaffected either way.
- Clients must label POST bodies `application/json` (ours always did; raw-fetch tests gained the header).
- The trusted-network assumption of an unauthenticated `0.0.0.0` deployment is now documented instead of implicit.
