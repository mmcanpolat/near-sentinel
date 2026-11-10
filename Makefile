.PHONY: run test test-live up

run:            ## start on http://localhost:3000 (Node 22+, no install step)
	node src/start.js

test:           ## unit tests: policy engine, key sandbox, units (offline)
	npm test

test-live:      ## also hit public NEAR mainnet RPC + NEAR Intents (read-only, quotes only)
	npm run test:live

up:             ## docker compose
	docker compose up --build
