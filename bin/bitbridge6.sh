#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_BIN:=$FIREWALLA_HOME/bin}

BINARY=bitbridge6

if [[ $(uname -m) == "aarch64" ]]; then
  if [[ -e /etc/armbian-release ]]; then
    BOARD=$( . /etc/*-release; echo $BOARD)
    case $BOARD in
      nanopineo2) ln -sfT real.aarch64 real ;;
      nanopi-r2s|NanoPi-NEO3-Black) ln -sfT real.navy real ;;
    esac
  fi
fi

if [[ $(uname -m) == "x86_64" ]]; then
  ln -sfT real.x86_64 real
fi

#branch=$(cd $FIREWALLA_HOME; git rev-parse --abbrev-ref HEAD)
# both beta and prod will disable ipv6
if [[ -e $FIREWALLA_BIN/dev || ! -f /home/pi/.firewalla/config/enablev6 ]]; then
  cp $FIREWALLA_BIN{/mock,}/$BINARY
else
  cp $FIREWALLA_BIN{/real,}/$BINARY
fi

sudo setcap cap_net_admin,cap_net_raw=eip $FIREWALLA_BIN/$BINARY

PIDS=""

for RC_FILE in $FIREWALLA_BIN/$BINARY.*.rc; do
  if [[ -e $RC_FILE ]]; then
    source $RC_FILE # taking arguments from here
  fi

  if [[ ! -z "$BINARY_ARGUMENTS" ]]; then
    $FIREWALLA_BIN/$BINARY $BINARY_ARGUMENTS &
    PIDS="$PIDS $!"
  fi
done

if [[ -n $PIDS ]]; then
  wait -n
  # considered as failure if any child process exits
  exit 1
else
  exit 0
fi
