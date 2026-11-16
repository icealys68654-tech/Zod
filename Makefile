# Common development tasks for a Node.js/TypeScript project.
# These targets expect the corresponding npm scripts to be defined in package.json.

.PHONY: help install build test lint clean

help:
	@echo "Available targets: install, build, test, lint, clean"

install:
	npm install

build:
	npm run build

test:
	npm test

lint:
	npm run lint

clean:
	rm -rf dist coverage
