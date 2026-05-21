(function() {
    var currentRoom = null;
    var account = null;

    // Check if already logged in
    account = Storage.getAccount();
    if (account) {
        showChatScreen();
    }

    // Auth handlers
    document.getElementById('loginBtn').addEventListener('click', function() {
        var username = document.getElementById('authUsername').value.trim();
        var password = document.getElementById('authPassword').value;
        if (!username || !password) { alert('Enter username and password.'); return; }

        var existing = Storage.getAccount();
        if (existing && existing.username === username && existing.passwordHash === CryptoUtil.hashPassword(password)) {
            account = existing;
            showChatScreen();
        } else if (existing) {
            alert('Incorrect password.');
        } else {
            alert('No account found. Click "Create Account" to make one.');
        }
    });

    document.getElementById('createBtn').addEventListener('click', function() {
        var username = document.getElementById('authUsername').value.trim();
        var password = document.getElementById('authPassword').value;
        if (!username || !password) { alert('Enter username and password.'); return; }
        if (password.length < 4) { alert('Password must be at least 4 characters.'); return; }

        var existing = Storage.getAccount();
        if (existing) {
            if (!confirm('An account already exists on this device. Replace it?')) return;
        }

        account = {
            username: username,
            passwordHash: CryptoUtil.hashPassword(password),
            peerId: CryptoUtil.generatePeerId(username),
            created: new Date().toISOString()
        };
        Storage.saveAccount(account);
        showChatScreen();
    });

    // Import identity
    document.getElementById('importBtn').addEventListener('click', function() {
        document.getElementById('importInput').click();
    });
    document.getElementById('importInput').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file) return;
        file.text().then(function(text) {
            var password = prompt('Enter the password for this identity:');
            if (!password) return;
            if (Storage.importIdentity(text, password)) {
                account = Storage.getAccount();
                showChatScreen();
            } else {
                alert('Import failed. Wrong password or invalid file.');
            }
        });
    });

    function showChatScreen() {
        document.getElementById('authScreen').classList.remove('active');
        document.getElementById('chatScreen').classList.add('active');

        // Set user info
        document.getElementById('myName').textContent = account.username;
        document.getElementById('myAvatar').textContent = account.username.charAt(0).toUpperCase();

        // Init peer connection
        PeerManager.init(account.peerId, account.username);
        PeerManager.onMessage = handleIncomingMessage;
        PeerManager.onPeerConnected = handlePeerConnected;
        PeerManager.onPeerDisconnected = handlePeerDisconnected;

        // Go online (Firebase presence)
        Presence.onUsersChanged = renderOnlineUsers;
        Presence.goOnline(account.peerId, account.username);

        renderChatList();
    }

    // New Chat Modal
    document.getElementById('newChatBtn').addEventListener('click', function() {
        document.getElementById('newChatModal').hidden = false;
    });
    document.getElementById('closeNewChat').addEventListener('click', function() {
        document.getElementById('newChatModal').hidden = true;
    });

    // Modal tabs
    document.querySelectorAll('.modal-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.modal-tab').forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.modal-tab-content').forEach(function(c) { c.classList.remove('active'); });
            tab.classList.add('active');
            document.getElementById(tab.dataset.target).classList.add('active');
        });
    });

    // Create room
    document.getElementById('createRoomBtn').addEventListener('click', function() {
        var name = document.getElementById('newRoomName').value.trim() || 'Chat';
        var isGroup = document.getElementById('isGroupChat').checked;
        var code = CryptoUtil.generateRoomCode(account.peerId);

        var chat = {
            roomCode: code,
            name: name,
            isGroup: isGroup,
            created: new Date().toISOString(),
            createdBy: account.peerId
        };

        Storage.addChat(chat);
        renderChatList();

        document.getElementById('generatedCode').textContent = code;
        document.getElementById('roomCodeDisplay').hidden = false;
    });

    document.getElementById('copyCodeBtn').addEventListener('click', function() {
        var code = document.getElementById('generatedCode').textContent;
        navigator.clipboard.writeText(code).then(function() {
            document.getElementById('copyCodeBtn').textContent = 'Copied!';
            setTimeout(function() { document.getElementById('copyCodeBtn').textContent = 'Copy Code'; }, 2000);
        });
    });

    // Join room
    document.getElementById('joinRoomBtn').addEventListener('click', function() {
        var code = document.getElementById('joinRoomCode').value.trim();
        if (!code) { alert('Enter a group code.'); return; }

        var creatorPeerId = CryptoUtil.extractPeerId(code);

        var chat = {
            roomCode: code,
            name: 'Group ' + code.split('.')[0],
            isGroup: true,
            joined: new Date().toISOString(),
            creatorPeerId: creatorPeerId
        };

        Storage.addChat(chat);
        renderChatList();
        document.getElementById('newChatModal').hidden = true;
        selectChat(code);

        // Connect to the creator
        if (creatorPeerId) {
            PeerManager.connectToPeer(creatorPeerId, code);
        }
    });

    // Settings
    document.getElementById('settingsBtn').addEventListener('click', function() {
        document.getElementById('myPeerId').textContent = account.peerId;
        document.getElementById('settingsModal').hidden = false;
    });
    document.getElementById('closeSettings').addEventListener('click', function() {
        document.getElementById('settingsModal').hidden = true;
    });

    document.getElementById('exportIdentityBtn').addEventListener('click', function() {
        var json = Storage.exportIdentity();
        if (!json) return;
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = account.username + '_identity.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    document.getElementById('logoutBtn').addEventListener('click', function() {
        if (!confirm('Sign out? Your messages are saved locally.')) return;
        Presence.goOffline();
        PeerManager.destroy();
        document.getElementById('chatScreen').classList.remove('active');
        document.getElementById('authScreen').classList.add('active');
        document.getElementById('settingsModal').hidden = true;
        account = null;
    });

    // Online users
    function renderOnlineUsers(users) {
        var html = '';
        var count = 0;
        users.forEach(function(user) {
            if (user.peerId === account.peerId) return; // Skip self
            count++;
            html += '<div class="online-user" data-peer="' + escapeHtml(user.peerId) + '">' +
                '<span class="online-dot"></span>' +
                '<span class="online-user-name">' + escapeHtml(user.username) + '</span>' +
                '<span class="online-user-chat">Chat</span></div>';
        });
        document.getElementById('onlineList').innerHTML = html || '<p style="padding:0.5rem 1rem;font-size:0.8rem;color:#b2bec3;">No one else online</p>';
        document.getElementById('onlineCount').textContent = count;

        // Click to start direct chat
        document.querySelectorAll('.online-user').forEach(function(el) {
            el.addEventListener('click', function() {
                var peerId = el.dataset.peer;
                var name = el.querySelector('.online-user-name').textContent;
                startDirectChat(peerId, name);
            });
        });
    }

    function startDirectChat(peerId, name) {
        console.log('startDirectChat called with:', peerId, name);
        // Create or find existing direct chat with this user
        var chats = Storage.getChats();
        var existing = chats.find(function(c) { return c.creatorPeerId === peerId || (c.directPeer === peerId); });

        var roomCode;
        if (existing) {
            roomCode = existing.roomCode;
        } else {
            roomCode = CryptoUtil.generateRoomCode(account.peerId);
            var chat = {
                roomCode: roomCode,
                name: name,
                isGroup: false,
                created: new Date().toISOString(),
                createdBy: account.peerId,
                directPeer: peerId
            };
            Storage.addChat(chat);
        }

        renderChatList();
        selectChat(roomCode);

        // Connect to the peer
        console.log('Connecting to peer:', peerId, 'room:', roomCode);
        PeerManager.connectToPeer(peerId, roomCode);
    }

    // Chat list
    function renderChatList() {
        var chats = Storage.getChats();
        var html = '';
        chats.forEach(function(chat) {
            var msgs = Storage.getMessages(chat.roomCode);
            var lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            var lastText = lastMsg ? (lastMsg.media ? '📎 Media' : lastMsg.text) : 'No messages yet';
            var lastTime = lastMsg ? formatTime(lastMsg.timestamp) : '';
            var avatarClass = chat.isGroup ? 'chat-item-avatar group' : 'chat-item-avatar';
            var initial = chat.name.charAt(0).toUpperCase();
            var activeClass = currentRoom === chat.roomCode ? ' active' : '';

            html += '<div class="chat-item' + activeClass + '" data-room="' + chat.roomCode + '">';
            html += '<div class="' + avatarClass + '">' + initial + '</div>';
            html += '<div class="chat-item-info"><div class="chat-item-name">' + escapeHtml(chat.name) + '</div>';
            html += '<div class="chat-item-last">' + escapeHtml(lastText) + '</div></div>';
            html += '<span class="chat-item-time">' + lastTime + '</span>';
            html += '</div>';
        });

        document.getElementById('chatList').innerHTML = html || '<p style="padding:1rem;color:#636e72;text-align:center;font-size:0.85rem;">No groups yet. Click + to start.</p>';

        document.querySelectorAll('.chat-item').forEach(function(item) {
            item.addEventListener('click', function() {
                selectChat(item.dataset.room);
            });
        });
    }

    function selectChat(roomCode) {
        currentRoom = roomCode;
        var chats = Storage.getChats();
        var chat = chats.find(function(c) { return c.roomCode === roomCode; });
        if (!chat) return;

        // Update header
        var peers = PeerManager.getConnectedPeers(roomCode);
        var isCreator = chat.createdBy === account.peerId;
        var deleteBtn = isCreator ? ' <button id="deleteGroupBtn" style="background:#d63031;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.75rem;cursor:pointer;margin-left:0.5rem;">Delete Group</button>' : '';

        document.getElementById('chatHeader').innerHTML =
            '<span class="chat-title">' + escapeHtml(chat.name) + ' <small style="color:#636e72;">(' + roomCode.split('.')[0] + ')</small>' + deleteBtn + '</span>' +
            '<span class="chat-status">' + peers + ' connected</span>';

        // Delete handler
        if (isCreator) {
            document.getElementById('deleteGroupBtn').addEventListener('click', function() {
                if (!confirm('Delete this group? This cannot be undone.')) return;
                var chats = Storage.getChats().filter(function(c) { return c.roomCode !== roomCode; });
                Storage.saveChats(chats);
                localStorage.removeItem('messenger_msgs_' + roomCode);
                currentRoom = null;
                document.getElementById('chatHeader').innerHTML = '<span class="chat-title">Select or start a chat</span>';
                document.getElementById('messages').innerHTML = '';
                document.getElementById('messageInputArea').hidden = true;
                renderChatList();
            });
        }

        // Reconnect to peer if not connected
        if (peers === 0) {
            if (chat.directPeer) {
                console.log('Reconnecting to direct peer:', chat.directPeer);
                PeerManager.connectToPeer(chat.directPeer, roomCode);
            } else if (chat.creatorPeerId && chat.creatorPeerId !== account.peerId) {
                console.log('Reconnecting to group creator:', chat.creatorPeerId);
                PeerManager.connectToPeer(chat.creatorPeerId, roomCode);
            }
        }

        document.getElementById('messageInputArea').hidden = false;
        renderMessages(roomCode);
        renderChatList();
    }

    function renderMessages(roomCode) {
        var msgs = Storage.getMessages(roomCode);
        var html = '';
        msgs.forEach(function(msg) {
            var isMine = msg.sender === account.peerId;
            var cls = isMine ? 'msg msg-sent' : 'msg msg-received';
            html += '<div class="' + cls + '">';
            if (!isMine) html += '<div class="msg-sender">' + escapeHtml(msg.senderName || 'Unknown') + '</div>';
            if (msg.media) {
                if (msg.mediaType && msg.mediaType.startsWith('video')) {
                    html += '<div class="msg-media"><video src="' + msg.media + '" controls></video></div>';
                } else {
                    html += '<div class="msg-media"><img src="' + msg.media + '"></div>';
                }
            }
            if (msg.text) html += '<div>' + escapeHtml(msg.text) + '</div>';
            html += '<div class="msg-time">' + formatTime(msg.timestamp) + '</div>';
            html += '</div>';
        });

        var container = document.getElementById('messages');
        container.innerHTML = html || '<p style="text-align:center;color:#636e72;margin-top:2rem;">No messages yet. Say hello!</p>';
        container.scrollTop = container.scrollHeight;
    }

    // Send message
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    document.getElementById('messageText').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendMessage();
    });

    function sendMessage() {
        var text = document.getElementById('messageText').value.trim();
        if (!text || !currentRoom) return;

        console.log('Sending message to room:', currentRoom, 'connections:', PeerManager.getConnectedPeers(currentRoom));

        var msg = {
            type: 'message',
            roomCode: currentRoom,
            sender: account.peerId,
            senderName: account.username,
            text: text,
            timestamp: Date.now()
        };

        Storage.saveMessage(currentRoom, msg);
        PeerManager.sendMessage(currentRoom, msg);
        renderMessages(currentRoom);
        renderChatList();
        document.getElementById('messageText').value = '';
    }

    // Attach media
    document.getElementById('attachBtn').addEventListener('click', function() {
        document.getElementById('attachInput').click();
    });
    document.getElementById('attachInput').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file || !currentRoom) return;

        // Convert to base64 for P2P transfer
        var reader = new FileReader();
        reader.onload = function(ev) {
            var msg = {
                type: 'message',
                roomCode: currentRoom,
                sender: account.peerId,
                senderName: account.username,
                text: '',
                media: ev.target.result,
                mediaType: file.type,
                timestamp: Date.now()
            };

            Storage.saveMessage(currentRoom, msg);
            PeerManager.sendMessage(currentRoom, msg);
            renderMessages(currentRoom);
            renderChatList();
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    // Handle incoming messages
    function handleIncomingMessage(data) {
        if (data.type === 'message' && data.roomCode) {
            Storage.saveMessage(data.roomCode, data);

            // Auto-add chat if we don't have it
            var chats = Storage.getChats();
            if (!chats.some(function(c) { return c.roomCode === data.roomCode; })) {
                Storage.addChat({ roomCode: data.roomCode, name: 'Group ' + data.roomCode.split('.')[0], isGroup: true });
            }

            if (currentRoom === data.roomCode) {
                renderMessages(data.roomCode);
            }
            renderChatList();
        }
    }

    function handlePeerConnected(peerId, roomCode, name) {
        if (currentRoom === roomCode) {
            var peers = PeerManager.getConnectedPeers(roomCode);
            var chatStatus = document.querySelector('.chat-status');
            if (chatStatus) chatStatus.textContent = peers + ' connected';
        }
    }

    function handlePeerDisconnected(peerId) {
        if (currentRoom) {
            var peers = PeerManager.getConnectedPeers(currentRoom);
            var chatStatus = document.querySelector('.chat-status');
            if (chatStatus) chatStatus.textContent = peers + ' connected';
        }
    }

    // Utilities
    function formatTime(timestamp) {
        var d = new Date(timestamp);
        var now = new Date();
        var hours = d.getHours().toString().padStart(2, '0');
        var mins = d.getMinutes().toString().padStart(2, '0');
        if (d.toDateString() === now.toDateString()) {
            return hours + ':' + mins;
        }
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hours + ':' + mins;
    }

    function escapeHtml(str) {
        if (!str) return '';
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Clean up on page close
    window.addEventListener('beforeunload', function() {
        Presence.goOffline();
    });
})();
