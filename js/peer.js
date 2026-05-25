/**
 * PeerJS connection management
 */
var PeerManager = {
    peer: null,
    connections: {},  // roomCode -> [connections]
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

        this.peer = new Peer(peerId, {
            debug: 0,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
                ]
            }
        });

        this.peer.on('open', function(id) {
            console.log('Connected to signaling server. ID:', id);
        });

        this.peer.on('disconnected', function() {
            console.log('Disconnected from signaling server. Reconnecting...');
            self.peer.reconnect();
        });

        this.peer.on('close', function() {
            console.log('Peer connection closed.');
        });

        // Reconnect when tab becomes visible again (mobile fix)
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden && self.peer) {
                if (self.peer.disconnected) {
                    console.log('Tab resumed. Reconnecting to signaling server...');
                    self.peer.reconnect();
                } else if (self.peer.destroyed) {
                    console.log('Tab resumed. Peer was destroyed. Reinitializing...');
                    self.init(self.myPeerId, self.myName);
                }
            }
        });

        this.peer.on('connection', function(conn) {
            console.log('Incoming connection from:', conn.peer);
            self.handleIncoming(conn);
        });

        this.peer.on('call', function(call) {
            if (self.onIncomingCall) self.onIncomingCall(call);
        });

        this.peer.on('error', function(err) {
            console.error('Peer error:', err.type, err.message);
            if (err.type === 'unavailable-id') {
                // ID temporarily taken (stale connection). Wait and retry.
                console.log('Peer ID unavailable. Retrying in 5 seconds...');
                setTimeout(function() {
                    if (self.peer) self.peer.destroy();
                    self.init(self.myPeerId, self.myName);
                }, 5000);
            } else if (err.type === 'disconnected') {
                self.peer.reconnect();
            }
        });
    },

    handleIncoming: function(conn) {
        var self = this;
        conn.on('open', function() {
            // Ask for room info
            conn.on('data', function(data) {
                self.handleData(conn, data);
            });
            conn.on('close', function() {
                self.removeConnection(conn);
                if (self.onPeerDisconnected) self.onPeerDisconnected(conn.peer);
            });
        });
    },

    connectToPeer: function(remotePeerId, roomCode) {
        var self = this;
        if (remotePeerId === this.myPeerId) return;
        
        // Clean up dead connections first
        if (this.connections[roomCode]) {
            this.connections[roomCode] = this.connections[roomCode].filter(function(c) { return c.open; });
        }

        // Don't connect if already connected to this peer in this room
        var existing = (this.connections[roomCode] || []).filter(function(c) { return c.peer === remotePeerId && c.open; });
        if (existing.length > 0) {
            return;
        }
        
        console.log('Attempting to connect to:', remotePeerId);

        var conn = this.peer.connect(remotePeerId, { reliable: true });
        conn.on('open', function() {
            console.log('Connection opened to:', remotePeerId);
            // Send join message
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
                self.removeConnection(conn);
                if (self.onPeerDisconnected) self.onPeerDisconnected(conn.peer);
            });

            // Store connection
            if (!self.connections[roomCode]) self.connections[roomCode] = [];
            self.connections[roomCode].push(conn);

            if (self.onPeerConnected) self.onPeerConnected(conn.peer, roomCode);
        });

        conn.on('error', function(err) {
            console.error('Connection error to', remotePeerId, ':', err);
        });
    },

    handleData: function(conn, data) {
        var self = this;
        if (data.type === 'join') {
            // Someone joined our room
            var roomCode = data.roomCode;
            if (!self.connections[roomCode]) self.connections[roomCode] = [];
            if (!self.connections[roomCode].some(function(c) { return c.peer === conn.peer; })) {
                self.connections[roomCode].push(conn);
            }
            if (self.onPeerConnected) self.onPeerConnected(data.peerId, roomCode, data.name);

            // Send back acknowledgment
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
            if (self.onMessage) self.onMessage(data);
        }
    },

    sendMessage: function(roomCode, message) {
        var conns = this.connections[roomCode] || [];
        conns.forEach(function(conn) {
            if (conn.open) {
                conn.send(message);
            }
        });
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

    destroy: function() {
        if (this.peer) this.peer.destroy();
    }
};
