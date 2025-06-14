#!/bin/bash

while true; do
    npm start & 
    NODE_PID=$!  # Capture process ID

    wait $NODE_PID
    echo "Backend crashed. Restarting..."

    # Ctrl+C equivalent to terminate
    kill -SIGINT $NODE_PID 2>/dev/null

    sleep 2
done