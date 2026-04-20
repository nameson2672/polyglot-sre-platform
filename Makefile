.DEFAULT_GOAL := help

.PHONY: help up down logs ps psql redis-cli reset-db clean

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