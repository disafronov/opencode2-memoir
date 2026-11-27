.PHONY: install build typecheck lint test test-integration all

install:
	npm install

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

test:
	npm test

test-integration:
	npm run test:integration

all: lint typecheck build test
