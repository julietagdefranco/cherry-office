#!/bin/bash
# Instala los agentes de Próspera HQ en Claude Code (copia, no mueve nada).
# - Reemplaza /Users/julietadefranco por tu $HOME real al copiar.
# - Si un archivo ya existe y es distinto, guarda un respaldo .bak con fecha antes de pisarlo.
# - Crea la memoria compartida ~/Próspera/_equipo/ solo si falta (nunca pisa lo existente).
# Se puede correr varias veces sin problema.
cd "$(dirname "$0")" || exit 1

ORIGEN_HOME="/Users/julietadefranco"
# Escapa \, & y | del $HOME para usarlo como reemplazo en sed.
HOME_SED=$(printf '%s' "$HOME" | sed -e 's/[\\&|]/\\&/g')
FECHA=$(date +%Y%m%d-%H%M%S)
PROYECTO="$HOME/Próspera"

NUEVOS=0; ACTUALIZADOS=0; IGUALES=0; RESPALDOS=0

# instalar_archivo ORIGEN DESTINO: copia adaptando rutas; respalda si el destino difiere.
instalar_archivo() {
  local origen="$1" destino="$2" tmp
  tmp=$(mktemp) || return 1
  sed "s|$ORIGEN_HOME|$HOME_SED|g" "$origen" > "$tmp"
  if [ ! -e "$destino" ]; then
    cp "$tmp" "$destino"; NUEVOS=$((NUEVOS+1))
  elif cmp -s "$tmp" "$destino"; then
    IGUALES=$((IGUALES+1))
  else
    cp -p "$destino" "$destino.bak-$FECHA"; RESPALDOS=$((RESPALDOS+1))
    cp "$tmp" "$destino"; ACTUALIZADOS=$((ACTUALIZADOS+1))
  fi
  rm -f "$tmp"
}

# copiar_si_falta ORIGEN DESTINO: nunca pisa; adapta rutas.
copiar_si_falta() {
  [ -e "$2" ] && return 0
  sed "s|$ORIGEN_HOME|$HOME_SED|g" "$1" > "$2"
  echo "  creado: ${2/#$HOME/~}"
}

mkdir -p "$HOME/.claude/agents" "$HOME/.claude/betty"
for f in agentes/*.md; do
  instalar_archivo "$f" "$HOME/.claude/agents/$(basename "$f")"
done
instalar_archivo contexto/contexto-maestro.md "$HOME/.claude/betty/contexto-maestro.md"

# Estado actual de Betty: solo si no existe (nunca se pisa ni se mueve).
mkdir -p "$PROYECTO/_betty"
copiar_si_falta contexto/estado-actual.EJEMPLO.md "$PROYECTO/_betty/estado-actual.md"

# Memoria compartida del equipo: solo plantillas que falten.
mkdir -p "$PROYECTO/_equipo/agentes"
copiar_si_falta contexto/equipo/decisiones.md "$PROYECTO/_equipo/decisiones.md"
for f in agentes/*.md; do
  id=$(basename "$f" .md)
  if [ ! -e "$PROYECTO/_equipo/agentes/$id.md" ]; then
    sed "s|<id del agente>|$id|" contexto/equipo/agente.PLANTILLA.md > "$PROYECTO/_equipo/agentes/$id.md"
    echo "  creado: ~/Próspera/_equipo/agentes/$id.md"
  fi
done

echo ""
echo "Listo. Agentes y contexto: $NUEVOS nuevos, $ACTUALIZADOS actualizados, $IGUALES sin cambios."
if [ "$RESPALDOS" -gt 0 ]; then
  echo "Se guardaron $RESPALDOS respaldos (archivos .bak-$FECHA) junto a los originales en ~/.claude."
fi
echo "Memoria compartida del equipo: ~/Próspera/_equipo/ (no se pisa nada de lo que ya tenías)."
echo "Para abrir la oficina: doble clic en oficina/Abrir Próspera HQ.command"
echo "(Abrí una sesión nueva de Claude Code para que reconozca a los agentes.)"
