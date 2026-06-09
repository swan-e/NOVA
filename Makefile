.PHONY: build rebuild up down restart logs up-scripts down-scripts

# ── Local (MCP only) ───────────────────────────────────────────────────────────
# Routine code change — compile TS, volume mount picks it up instantly.
build:
	npm run build
	docker compose restart mcp scripts

# Full reset — use when changing dependencies or Dockerfile/compose config.
rebuild:
	npm run build
	docker compose build --no-cache
	docker compose up -d

# Start MCP + scripts + ofelia (normal working session).
up:
	npm run build
	docker compose up -d

# Stop everything local.
down:
	docker compose down

# Restart specific containers.
restart:
	docker compose restart mcp scripts

# Tail logs from local containers.
logs:
	docker compose logs -f

# ── Scripts only (always-on, separate from MCP) ────────────────────────────────
# Start just scripts + ofelia without MCP (e.g. after closing a working session).
up-scripts:
	docker compose up -d scripts ofelia

# Stop just scripts + ofelia.
down-scripts:
	docker compose down scripts ofelia