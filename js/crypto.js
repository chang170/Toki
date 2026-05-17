/**
 * Crypto utilities for identity management
 */
var CryptoUtil = {
    // Generate a simple hash for password
    hashPassword: function(password) {
        var hash = 0;
        for (var i = 0; i < password.length; i++) {
            var chr = password.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return 'h' + Math.abs(hash).toString(36);
    },

    // Generate a unique peer ID
    generatePeerId: function(username) {
        var rand = Math.random().toString(36).substring(2, 10);
        var time = Date.now().toString(36);
        return 'msg-' + username.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + rand + time;
    },

    // Generate room code that includes full peer ID
    generateRoomCode: function(peerId) {
        var rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        return rand + '.' + peerId;
    },

    // Extract peer ID from room code
    extractPeerId: function(roomCode) {
        var dotIdx = roomCode.indexOf('.');
        if (dotIdx !== -1) {
            return roomCode.substring(dotIdx + 1);
        }
        return null;
    }
};
