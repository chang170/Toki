/**
 * PeerJS connection management
 */
var PeerManager = {
    peer: null,
    connections: {},  // roomCode -> [connections]
    onMessage: null,
    onPeerConnected: null,
    onPeerDisconnected: null,
    myPeerId: null,
    myName: null,

    init: function(peerId, displayName) {
        var self = this;
        this.myPeerId = peerId;
        this.myName = displayName;

        this.peer = new Peer(peerId, {
            debug: 0
        });

        this.peer.on('open', function(id) {
            console.log('Connected to signaling server. ID:', id);
        });

        this.peer.on('connection', function(conn) {
            self.handleIncoming(conn);
        });

        this.peer.on('error', function(err) {
            console.error('Peer error:', err.type, err.message);
            if (err.type === 'unavailable-id') {
                // ID taken, regenerate
                alert('Connection ID conflict. Please try again.');
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

        var conn = this.peer.connect(remotePeerId, { reliable: true });
        conn.on('open', function() {
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
            console.error('Connection error:', err);
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
        } else if (data.type === 'message') {
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
