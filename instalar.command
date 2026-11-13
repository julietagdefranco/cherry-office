#!/bin/bash
# Instala los agentes de Próspera HQ en Claude Code (copia, no mueve nada).
cd "$(dirname "$0")"
mkdir -p ~/.claude/agents ~/.claude/betty
cp agentes/*.md ~/.claude/agents/
cp contexto/contexto-maestro.md ~/.claude/betty/
mkdir -p "$HOME/Próspera/_betty"
[ -f "$HOME/Próspera/_betty/estado-actual.md" ] || cp contexto/estado-actual.EJEMPLO.md "$HOME/Próspera/_betty/estado-actual.md"
echo "Listo: 8 agentes instalados en ~/.claude/agents."
echo "Para abrir la oficina: doble clic en oficina/Abrir Próspera HQ.command"
echo "(Abrí una sesión nueva de Claude Code para que reconozca a los agentes.)"
