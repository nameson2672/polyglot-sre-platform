.DEFAULT_GOAL := help

.PHONY: help up down logs ps psql redis-cli reset-db clean \
        dev-up dev-down dev-down-full dev-logs \
        smoke traffic-steady traffic-spike traffic-mixed traffic-chaos e2e-full

help: ## List all available targets with comments
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

up: ## Start local Postgres + Redis via docker-compose
	docker compose up -d

down: ## Stop local services
	docker compose down

logs: ## Tail all service logs
	docker compose logs -f

ps: ## Show container status
	docker compose ps

psql: ## Open psql shell to local Postgres
	psql "postgresql://orders:orders_dev@localhost:5432/orders"

redis-cli: ## Open redis-cli
	redis-cli

reset-db: ## Drop and recreate dev database
	docker compose down postgres
	docker volume rm $$(basename $$(pwd))_pg_data 2>/dev/null || true
	docker compose up -d postgres
	@echo "Waiting for database to be ready..."
	@sleep 5

clean: ## Remove node_modules, bin, obj directories
	find . -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null || true
	find . -name "bin" -type d -exec rm -rf {} + 2>/dev/null || true
	find . -name "obj" -type d -exec rm -rf {} + 2>/dev/null || true

dev-up: ## Start infra + all 3 services locally (tmux if available, else background)
	@bash scripts/dev-up.sh

dev-down: ## Stop all 3 services (keep infra running)
	@bash scripts/dev-down.sh

dev-down-full: ## Stop all 3 services AND Docker infra
	@bash scripts/dev-down.sh --full

dev-logs: ## Tail all service logs
	@tail -F /tmp/polyglot-sre-logs/*.log

smoke: ## Run 10-check E2E smoke test
	@bash tools/e2e/smoke.sh

traffic-steady: ## 5 RPS realistic load — run in a separate terminal for Grafana demos
	@cd tools/e2e/traffic-generator && npx tsx src/index.ts steady --rps 5

traffic-spike: ## Ramp 1→50 RPS spike test (5 min)
	@cd tools/e2e/traffic-generator && npx tsx src/index.ts spike --duration 300

traffic-mixed: ## 80/20 valid/invalid traffic mix at 10 RPS
	@cd tools/e2e/traffic-generator && npx tsx src/index.ts mixed --rps 10

traffic-chaos: ## Hit /slow endpoint at 2 RPS for SLO burn demos
	@cd tools/e2e/traffic-generator && npx tsx src/index.ts chaos --rps 2

e2e-full: ## Full cycle: dev-up → smoke → 30s traffic → dev-down
	@bash scripts/dev-up.sh
	@sleep 5
	@bash tools/e2e/smoke.sh
	@cd tools/e2e/traffic-generator && \
	  (npx tsx src/index.ts steady --rps 5 --duration 30 || true)
	@bash scripts/dev-down.sh