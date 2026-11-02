SHELL := /bin/sh

PID_FILE := .google-flow-mcp.pid
LOG_FILE := .google-flow-mcp.log
KILL := /bin/kill

.PHONY: up down

up:
	@if [ -f "$(PID_FILE)" ] && $(KILL) -0 -- -$$(cat "$(PID_FILE)") 2>/dev/null; then \
		echo "google-flow-mcp já está em execução (PID $$(cat "$(PID_FILE)"))."; \
	else \
		rm -f "$(PID_FILE)"; \
		command -v setsid >/dev/null 2>&1 || { echo "Erro: o comando setsid é necessário para make up." >&2; exit 1; }; \
		npm run build || exit $$?; \
		setsid sh -c 'tail -f /dev/null | node dist/cli.js' </dev/null >"$(LOG_FILE)" 2>&1 & echo $$! >"$(PID_FILE)"; \
		sleep 1; \
		if $(KILL) -0 -- -$$(cat "$(PID_FILE)") 2>/dev/null; then \
			echo "google-flow-mcp iniciado (PID $$(cat "$(PID_FILE)")). Log: $(LOG_FILE)"; \
		else \
			echo "Não foi possível iniciar google-flow-mcp. Consulte $(LOG_FILE)." >&2; \
			rm -f "$(PID_FILE)"; \
			exit 1; \
		fi; \
	fi

down:
	@if [ ! -f "$(PID_FILE)" ]; then \
		echo "google-flow-mcp não está em execução."; \
	else \
		pid=$$(cat "$(PID_FILE)"); \
		if $(KILL) -0 -- -$$pid 2>/dev/null; then \
			$(KILL) -TERM -- -$$pid; \
			echo "google-flow-mcp parado (PID $$pid)."; \
		else \
			echo "Processo google-flow-mcp não encontrado; removendo PID antigo."; \
		fi; \
		rm -f "$(PID_FILE)"; \
	fi
