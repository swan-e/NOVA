.PHONY: build rebuild up down restart logs

# Routine code change — compile TS, volume mount picks it up instantly.
build:
	npm run build
	docker compose restart mcp scripts

# Full reset — use when changing dependencies or Docker/compose config.
rebuild:
	npm run build
	docker compose build
	docker compose up -d

# Start containers (first time or after they were stopped).
up:
	npm run build
	docker compose up -d

# Stop all containers.
down:
	docker compose down

# Restart container
restart:
	docker compose restart mcp scripts

# Tail logs from all containers.
logs:
	docker compose logs -f
