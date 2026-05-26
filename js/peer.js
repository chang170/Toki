/**
 * PeerJS connection management - with full diagnostic logging
 */

var PeerManager = {
    peer: null,
    connections: {},
    onMessage: null,
    onPeerConnected: null,
    onPeerDisconnected: null,
    onIncomingCall: null,
    myPeerId: null,
    myName: null,

    init: function(peerId, displayName) {
        var self = this;
        this.myPeerId = peerId;
        this.myName = displayName;

        console.log('[PEER] Initializing with ID:', peerId);

        this.peer = new Peer(peerId, {
            debug: 0,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
                ]
            }
        });

        this.peer.on('open', function(id) {
            console.log('[PEER] Connected to signaling server. ID:', id);
            self.startHeartbeat();
        });

        this.peer.on('disconnected', function() {
            console.log('[PEER] Disconnected from signaling server. Reconnecting...');
            self.peer.reconnect();
        });

        this.peer.on('close', function() {
            console.log('[PEER] Connection closed.');
        });

        document.addEventListener('visibilitychange', function() {
            if (!document.hidden && self.peer) {
                if (self.peer.disconnected) {
                    console.log('[PEER] Tab resumed - reconnecting...');
                    self.peer.reconnect();
                } else if (self.peer.destroyed) {
                    console.log('[PEER] Tab resumed - reinitializing...');
                    self.init(self.myPeerId, self.myName);
                }
            }
        });

        this.peer.on('error', function(err) {
            console.error('[PEER] Error:', err.type, err.message);
            if (err.type === 'unavailable-id') {
                console.log('[PEER] ID taken. Retrying in 15 seconds...');
                setTimeout(function() {
                    if (self.peer) self.peer.destroy();
                    self.init(self.myPeerId, self.myName);
                }, 15000);
            } else if (err.type === 'disconnected') {
                self.peer.reconnect();
            } else if (err.type === 'peer-unavailable') {
                console.log('[PEER] Target peer not registered on signaling server');
            }
        });

        this.peer.on('connection', function(conn) {
            console.log('[PEER] Incoming connection from:', conn.peer);
            self.handleIncoming(conn);
        });

        this.peer.on('call', function(call) {
            console.log('[PEER] Incoming call from:', call.peer);
            if (self.onIncomingCall) self.onIncomingCall(call);
        });
    },

    handleIncoming: function(conn) {
        var self = this;
        console.log('[PEER] handleIncoming - waiting for open from:', conn.peer);

        conn.on('open', function() {
            console.log('[PEER] ✓ Incoming connection OPENED from:', conn.peer);

            conn.on('data', function(data) {
                self.handleData(conn, data);
            });
            conn.on('close', function() {
                console.log('[PEER] Connection closed from:', conn.peer);
                self.removeConnection(conn);
                if (self.onPeerDisconnected) self.onPeerDisconnected(conn.peer);
            });

            // Store connection under matching local DM room
            var chats = JSON.parse(localStorage.getItem('messenger_chats') || '[]');
            console.log('[PEER] Checking', chats.length, 'chats for peer:', conn.peer);
            var matched = false;
            chats.forEach(function(chat) {
                if (chat.directPeer === conn.peer) {
                    matched = true;
                    console.log('[PEER] ✓ Match! Storing under room:', chat.roomCode);
                    if (!self.connections[chat.roomCode]) self.connections[chat.roomCode] = [];
                    // Remove any stale connections to this peer (replace with fresh incoming)
                    self.connections[chat.roomCode] = self.connections[chat.roomCode].filter(function(c) {
                        return c.peer !== conn.peer;
                    });
                    self.connections[chat.roomCode].push(conn);
                    if (self.onPeerConnected) self.onPeerConnected(conn.peer, chat.roomCode);
                }
            });
            if (!matched) {
                console.log('[PEER] ✗ No matching chat found for peer:', conn.peer);
            }
        });

        // Log if open never fires
        setTimeout(function() {
            if (!conn.open) {
                console.log('[PEER] ✗ Connection from', conn.peer, 'never opened (timeout 10s)');
            }
        }, 10000);
    },

    connectToPeer: function(remotePeerId, roomCode) {
        var self = this;
        if (remotePeerId === this.myPeerId) return;

        // Clean up dead connections
        if (this.connections[roomCode]) {
            this.connections[roomCode] = this.connections[roomCode].filter(function(c) { return c.open; });
        }

        // Don't connect if already connected
        var existing = (this.connections[roomCode] || []).filter(function(c) { return c.peer === remotePeerId && c.open; });
        if (existing.length > 0) {
            console.log('[PEER] Already connected to:', remotePeerId);
            return;
        }

        console.log('[PEER] Connecting to:', remotePeerId, 'room:', roomCode);

        var conn = this.peer.connect(remotePeerId, { reliable: true });
        conn.on('open', function() {
            console.log('[PEER] ✓ Outgoing connection OPENED to:', remotePeerId);

            conn.send({
                type: 'join',
                roomCode: roomCode,
                name: self.myName,
                peerId: self.myPeerId
            });

            conn.on('data', function(data) {
                self.handleData(conn, data);
            });
            conn.on('close', function() {
                console.log('[PEER] Outgoing connection closed to:', remotePeerId);
                self.removeConnection(conn);
                if (self.onPeerDisconnected) self.onPeerDisconnected(conn.peer);
            });

            if (!self.connections[roomCode]) self.connections[roomCode] = [];
            // Replace any stale connections to this peer
            self.connections[roomCode] = self.connections[roomCode].filter(function(c) {
                return c.peer !== remotePeerId;
            });
            self.connections[roomCode].push(conn);

            if (self.onPeerConnected) self.onPeerConnected(conn.peer, roomCode);
        });

        conn.on('error', function(err) {
            console.error('[PEER] Connection error to', remotePeerId, ':', err);
        });

        // Log if open never fires
        setTimeout(function() {
            if (!conn.open) {
                console.log('[PEER] ✗ Outgoing to', remotePeerId, 'never opened (timeout 10s)');
            }
        }, 10000);
    },

    handleData: function(conn, data) {
        var self = this;
        if (data.type === 'join') {
            var roomCode = data.roomCode;
            if (!self.connections[roomCode]) self.connections[roomCode] = [];
            if (!self.connections[roomCode].some(function(c) { return c.peer === conn.peer; })) {
                self.connections[roomCode].push(conn);
            }
            if (self.onPeerConnected) self.onPeerConnected(data.peerId, roomCode, data.name);

            conn.send({
                type: 'joined',
                roomCode: roomCode,
                name: self.myName,
                peerId: self.myPeerId
            });
        } else if (data.type === 'joined') {
            var roomCode = data.roomCode;
            if (!self.connections[roomCode]) self.connections[roomCode] = [];
            if (!self.connections[roomCode].some(function(c) { return c.peer === conn.peer; })) {
                self.connections[roomCode].push(conn);
            }
            if (self.onPeerConnected) self.onPeerConnected(data.peerId, roomCode, data.name);
        } else if (data.type === 'message' || data.type === 'receipt' || data.type === 'delete' || data.type === 'invite' || data.type === 'deleteGroup' || data.type === 'hangup') {
            console.log('[PEER] ← Received', data.type, data.receiptType || '', 'from:', conn.peer, 'msgId:', data.msgId || '');
            if (self.onMessage) self.onMessage(data);
        } else if (data.type === 'ping') {
            // Respond with pong
            try { conn.send({ type: 'pong', ts: data.ts }); } catch(e) {}
        } else if (data.type === 'pong') {
            // Mark connection as alive
            conn._lastPong = Date.now();
        }
    },

    sendMessage: function(roomCode, message) {
        var self = this;
        var conns = this.connections[roomCode] || [];
        var sent = false;
        conns.forEach(function(conn) {
            if (conn._dead) return; // Skip connections marked dead
            if (conn.open) {
                // Check actual DataChannel state
                var dc = conn.dataChannel || (conn._dc) || null;
                if (dc && dc.readyState !== 'open') {
                    console.log('[PEER] DataChannel not open (state:', dc.readyState, ') - removing:', conn.peer);
                    self.removeConnection(conn);
                    return;
                }
                try {
                    conn.send(message);
                    sent = true;
                } catch(e) {
                    console.log('[PEER] Send threw error, removing dead connection:', conn.peer, e.message);
                    self.removeConnection(conn);
                }
            }
        });
        if (!sent) {
            console.log('[PEER] sendMessage failed - no open connections for room:', roomCode, 'conns:', conns.length);
        }
        return sent;
    },

    removeConnection: function(conn) {
        for (var room in this.connections) {
            this.connections[room] = this.connections[room].filter(function(c) {
                return c.peer !== conn.peer;
            });
        }
    },

    getConnectedPeers: function(roomCode) {
        var conns = this.connections[roomCode] || [];
        return conns.filter(function(c) { return c.open; }).length;
    },

    // Heartbeat system - detect dead connections
    startHeartbeat: function() {
        var self = this;
        this.heartbeatInterval = setInterval(function() {
            var allConns = [];
            for (var room in self.connections) {
                self.connections[room].forEach(function(conn) {
                    if (conn.open && !allConns.some(function(c) { return c.peer === conn.peer; })) {
                        allConns.push(conn);
                    }
                });
            }
            allConns.forEach(function(conn) {
                // Send ping
                try {
                    conn._lastPing = Date.now();
                    conn.send({ type: 'ping', ts: Date.now() });
                } catch(e) {
                    console.log('[PEER] Ping failed, connection dead:', conn.peer);
                    self.removeConnection(conn);
                    if (self.onPeerDisconnected) self.onPeerDisconnected(conn.peer);
                }
            });

            // Check for pong timeout after 5 seconds
            setTimeout(function() {
                allConns.forEach(function(conn) {
                    if (conn._lastPing && !conn._lastPong) {
                        // Never got a pong - first ping, give it a pass
                        conn._lastPong = 0;
                    } else if (conn._lastPing && conn._lastPong < conn._lastPing) {
                        // Pong didn't come back - connection is dead
                        console.log('[PEER] ✗ No pong from:', conn.peer, '- connection dead, removing');
                        conn._dead = true;
                        self.removeConnection(conn);
                        try { conn.close(); } catch(e) {}
                        if (self.onPeerDisconnected) self.onPeerDisconnected(conn.peer);
                    }
                });
            }, 5000);
        }, 15000);
    },

    destroy: function() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.peer) this.peer.destroy();
    }
};
