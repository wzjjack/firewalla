#!/bin/bash

INSTANCE=$1

mkdir -p /etc/openvpn/ovpn_server

GATEWAY_FILE="/etc/openvpn/ovpn_server/$INSTANCE.gateway"
rm -f $GATEWAY_FILE

SUBNET_FILE="/etc/openvpn/ovpn_server/$INSTANCE.subnet"
rm -f $SUBNET_FILE

LOCAL_FILE="/etc/openvpn/ovpn_server/$INSTANCE.local"
rm -f $LOCAL_FILE

# send to firerouter redis db
redis-cli -n 1 publish "ifdown" "$dev" || true

if [[ $(uname -m) == "x86_64" ]]; then
  (sudo iptables -w -C FW_INPUT_ACCEPT -p tcp --dport $local_port_1 -j ACCEPT &>/dev/null && sudo iptables -w -D FW_INPUT_ACCEPT -p tcp --dport $local_port_1 -j ACCEPT) || true
  (sudo iptables -w -C FW_INPUT_ACCEPT -p udp --dport $local_port_1 -j ACCEPT &>/dev/null && sudo iptables -w -D FW_INPUT_ACCEPT -p udp --dport $local_port_1 -j ACCEPT) || true
  (sudo iptables -w -t nat -C FW_PREROUTING_DMZ_HOST -p tcp --dport $local_port_1 -j ACCEPT &>/dev/null && sudo iptables -w -t nat -D FW_PREROUTING_DMZ_HOST -p tcp --dport $local_port_1 -j ACCEPT) || true
  (sudo iptables -w -t nat -C FW_PREROUTING_DMZ_HOST -p udp --dport $local_port_1 -j ACCEPT &>/dev/null && sudo iptables -w -t nat -D FW_PREROUTING_DMZ_HOST -p udp --dport $local_port_1 -j ACCEPT) || true
fi