/**
 * Firebase Realtime Database - User Presence
 * Only used for "who's online" - no messages stored on server
 */
var Presence = {
    dbUrl: 'https://toki-25ff3-default-rtdb.firebaseio.com',
    myKey: null,
    onUsersChanged: null,
    pollInterval: null,

    // Register as online
    goOnline: function(peerId, username) {
        var self = this;
        this.myKey = peerId.replace(/[.#$\[\]\/]/g, '_');
        var data = JSON.stringify({
            peerId: peerId,
            username: username,
            lastSeen: Date.now()
        });

        // Set presence
        this.put(this.myKey, data);

        // Poll for users every 5 seconds
        this.pollInterval = setInterval(function() {
            var profile = JSON.parse(localStorage.getItem('toki_profile') || '{}');
            // Update my timestamp
            self.put(self.myKey, JSON.stringify({
                peerId: peerId,
                username: profile.nickname || profile.firstName || username,
                picture: profile.picture || '',
                showLastSeen: profile.showLastSeen !== false,
                lastSeen: Date.now()
            }));
            // Fetch all users
            self.fetchUsers();
        }, 5000);

        // Initial fetch
        this.fetchUsers();
    },

    // Go offline - stop updating but keep entry for "last seen"
    goOffline: function() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    // Fetch all online users
    fetchUsers: function() {
        var self = this;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', this.dbUrl + '/presence.json', true);
        xhr.onload = function() {
            if (xhr.status === 200) {
                var data = JSON.parse(xhr.responseText);
                var users = [];
                var now = Date.now();
                if (data) {
                    for (var key in data) {
                        var user = data[key];
                        // Consider online if seen in last 30 seconds
                        if (now - user.lastSeen < 30000) {
                            user.online = true;
                            users.push(user);
                        } else if (now - user.lastSeen < 86400000) {
                            // Seen in last 24 hours - show as offline with last seen
                            user.online = false;
                            users.push(user);
                        } else {
                            // Clean up stale entries older than 24 hours
                            self.delete(key);
                        }
                    }
                }
                if (self.onUsersChanged) self.onUsersChanged(users);
            }
        };
        xhr.send();
    },

    // Firebase REST API helpers
    put: function(key, jsonStr) {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', this.dbUrl + '/presence/' + key + '.json', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(jsonStr);
    },

    delete: function(key) {
        var xhr = new XMLHttpRequest();
        xhr.open('DELETE', this.dbUrl + '/presence/' + key + '.json', true);
        xhr.send();
    },

    // Store a pending invite in Firebase
    sendInvite: function(targetPeerId, inviteData) {
        var key = targetPeerId.replace(/[.#$\[\]\/]/g, '_');
        var xhr = new XMLHttpRequest();
        var id = Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        xhr.open('PUT', this.dbUrl + '/invites/' + key + '/' + id + '.json', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify(inviteData));
    },

    // Register account in Firebase
    registerAccount: function(username, passwordHash, peerId, callback) {
        var self = this;
        var key = username.toLowerCase().replace(/[^a-z0-9]/g, '_');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', this.dbUrl + '/accounts/' + key + '.json', true);
        xhr.onload = function() {
            if (xhr.status === 200 && xhr.responseText !== 'null') {
                callback(false, 'exists');
                return;
            }
            var data = JSON.stringify({ username: username, passwordHash: passwordHash, peerId: peerId, created: Date.now() });
            var xhr2 = new XMLHttpRequest();
            xhr2.open('PUT', self.dbUrl + '/accounts/' + key + '.json', true);
            xhr2.setRequestHeader('Content-Type', 'application/json');
            xhr2.onload = function() { callback(true); };
            xhr2.send(data);
        };
        xhr.send();
    },

    // Login with Firebase
    loginAccount: function(username, password, callback) {
        var key = username.toLowerCase().replace(/[^a-z0-9]/g, '_');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', this.dbUrl + '/accounts/' + key + '.json', true);
        xhr.onload = function() {
            if (xhr.status === 200 && xhr.responseText !== 'null') {
                var data = JSON.parse(xhr.responseText);
                if (data.passwordHash === CryptoUtil.hashPassword(password)) {
                    callback(data);
                } else {
                    callback(null); // Wrong password
                }
            } else {
                callback(undefined); // Not found
            }
        };
        xhr.send();
    },

    // Update peer ID in Firebase account
    updatePeerId: function(username, peerId) {
        var self = this;
        var key = username.toLowerCase().replace(/[^a-z0-9]/g, '_');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', this.dbUrl + '/accounts/' + key + '.json', true);
        xhr.onload = function() {
            if (xhr.status === 200 && xhr.responseText !== 'null') {
                var data = JSON.parse(xhr.responseText);
                data.peerId = peerId;
                var xhr2 = new XMLHttpRequest();
                xhr2.open('PUT', self.dbUrl + '/accounts/' + key + '.json', true);
                xhr2.setRequestHeader('Content-Type', 'application/json');
                xhr2.send(JSON.stringify(data));
            }
        };
        xhr.send();
    },

    // Check if a specific peer is online
    isPeerOnline: function(peerId) {
        var key = peerId.replace(/[.#$\[\]\/]/g, '_');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', this.dbUrl + '/presence/' + key + '.json', false); // synchronous
        xhr.send();
        if (xhr.status === 200) {
            var data = JSON.parse(xhr.responseText);
            if (data && (Date.now() - data.lastSeen) < 30000) {
                return true;
            }
        }
        return false;
    },

    // Check for pending invites
    checkInvites: function(myPeerId, callback) {
        var self = this;
        var key = myPeerId.replace(/[.#$\[\]\/]/g, '_');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', this.dbUrl + '/invites/' + key + '.json', true);
        xhr.onload = function() {
            if (xhr.status === 200) {
                var data = JSON.parse(xhr.responseText);
                if (data) {
                    var invites = [];
                    for (var id in data) {
                        invites.push(data[id]);
                    }
                    if (invites.length > 0 && callback) {
                        callback(invites);
                    }
                    // Clear delivered invites
                    var delXhr = new XMLHttpRequest();
                    delXhr.open('DELETE', self.dbUrl + '/invites/' + key + '.json', true);
                    delXhr.send();
                }
            }
        };
        xhr.send();
    }
};
