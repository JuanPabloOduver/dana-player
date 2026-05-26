# start.sh — poner en la raíz del proyecto
#!/bin/bash
echo "Iniciando danaplayd..."
./danaplayerd/danaplayd &
DAEMON_PID=$!

# Esperar a que el socket exista (máx 5 segundos)
for i in $(seq 1 10); do
    [ -S /tmp/danaplayd.sock ] && break
    sleep 0.5
done

echo "Iniciando Electron..."
npm start

# Al cerrar Electron, matar el daemon
kill $DAEMON_PID 2>/dev/null
pkill -f "danaplayd/danaplayd" 2>/dev/null
