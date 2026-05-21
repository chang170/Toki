(function() {
    // App version - increment to force localStorage reset on all devices
    // App version - only increment for BREAKING changes that need localStorage reset
    var APP_VERSION = '4';
    var storedVersion = localStorage.getItem('messenger_version');
    if (storedVersion !== APP_VERSION) {
        var keys = Object.keys(localStorage).filter(function(k) { return k.startsWith('messenger_'); });
        keys.forEach(function(k) { localStorage.removeItem(k); });
        localStorage.setItem('messenger_version', APP_VERSION);
    }

    var currentRoom = null;
    var account = null;
    var unreadCounts = {};
    var processedMsgIds = {};

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
        var code = CryptoUtil.generateRoomCode(account.peerId, name);

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
        var groupName = CryptoUtil.extractGroupName(code) || 'Group ' + code.split('.')[0];

        var chat = {
            roomCode: code,
            name: groupName,
            isGroup: true,
            joined: new Date().toISOString(),
            creatorPeerId: creatorPeerId
        };

        Storage.addChat(chat);
        renderChatList();
        document.getElementById('newChatModal').hidden = true;
        document.getElementById('joinRoomCode').value = '';
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

    // Theme switching
    var savedTheme = localStorage.getItem('toki_theme') || 'default';
    applyTheme(savedTheme);

    document.querySelectorAll('.theme-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var theme = btn.dataset.theme;
            applyTheme(theme);
            localStorage.setItem('toki_theme', theme);
        });
    });

    function applyTheme(theme) {
        document.body.className = '';
        if (theme !== 'default') {
            document.body.classList.add('theme-' + theme);
        }
        document.querySelectorAll('.theme-btn').forEach(function(b) { b.classList.remove('active'); });
        var activeBtn = document.querySelector('.theme-btn[data-theme="' + theme + '"]');
        if (activeBtn) activeBtn.classList.add('active');
    }

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
            html += '<div class="online-user" data-peer="' + escapeHtml(user.peerId) + '" data-name="' + escapeHtml(user.username) + '">' +
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
                var name = el.dataset.name;
                startDirectChat(peerId, name);
            });
        });
    }

    function startDirectChat(peerId, name) {
        // Generate a deterministic room code from both peer IDs
        var ids = [account.peerId, peerId].sort();
        var roomCode = 'DM.' + ids[0] + '.' + ids[1];

        // Create or find existing direct chat with this user
        var chats = Storage.getChats();
        var existing = chats.find(function(c) { return c.roomCode === roomCode; });

        if (!existing) {
            var chat = {
                roomCode: roomCode,
                name: name,
                isGroup: false,
                created: new Date().toISOString(),
                createdBy: account.peerId,
                directPeer: peerId
            };
            Storage.addChat(chat);
            renderChatList();
        }

        selectChat(roomCode);

        // Only connect if not already connected
        if (PeerManager.getConnectedPeers(roomCode) === 0) {
            console.log('Connecting to peer:', peerId);
            PeerManager.connectToPeer(peerId, roomCode);
        }
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
            var unread = unreadCounts[chat.roomCode] || 0;
            var unreadBadge = unread > 0 ? '<span class="unread-badge">' + unread + '</span>' : '';
            html += '<div class="chat-item-meta"><span class="chat-item-time">' + lastTime + '</span>' + unreadBadge + '</div>';
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
        // Clear unread for this chat
        delete unreadCounts[roomCode];
        updateTitleBadge();

        var chats = Storage.getChats();
        var chat = chats.find(function(c) { return c.roomCode === roomCode; });
        if (!chat) return;

        // Send read receipts for unread messages in this chat
        var msgs = Storage.getMessages(roomCode) || [];
        msgs.forEach(function(msg) {
            if (msg && msg.sender !== account.peerId && msg.msgId && !msg.readReceiptSent) {
                PeerManager.sendMessage(roomCode, {
                    type: 'receipt',
                    receiptType: 'read',
                    msgId: msg.msgId,
                    roomCode: roomCode,
                    sender: account.peerId
                });
            }
        });

        // Update header
        var peers = PeerManager.getConnectedPeers(roomCode);
        var isCreator = chat.createdBy === account.peerId;
        var deleteBtn = '';
        if (chat.isGroup && isCreator) {
            deleteBtn = ' <button id="deleteGroupBtn" style="background:#d63031;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.75rem;cursor:pointer;margin-left:0.5rem;">Delete</button>';
        } else if (!chat.isGroup) {
            deleteBtn = ' <button id="deleteGroupBtn" style="background:#d63031;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.75rem;cursor:pointer;margin-left:0.5rem;">Delete</button>';
        }
        var inviteBtn = chat.isGroup ? ' <button id="inviteBtn" style="background:#00b894;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.75rem;cursor:pointer;margin-left:0.5rem;">Invite</button>' : '';

        document.getElementById('chatHeader').innerHTML =
            '<button class="back-btn" id="backBtn">←</button>' +
            '<span class="chat-title">' + escapeHtml(chat.name) + ' <small style="color:#636e72;">(' + roomCode.split('.')[0] + ')</small>' + inviteBtn + deleteBtn + '</span>' +
            '<span class="chat-status">' + peers + ' connected</span>';

        // Delete handler
        if (document.getElementById('deleteGroupBtn')) {
            document.getElementById('deleteGroupBtn').addEventListener('click', function() {
                if (!confirm('Delete this chat? This cannot be undone.')) return;
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

        // Invite handler
        if (chat.isGroup && document.getElementById('inviteBtn')) {
            document.getElementById('inviteBtn').addEventListener('click', function() {
                showInviteModal(roomCode, chat.name);
            });
        }

        // Back button handler (mobile)
        if (document.getElementById('backBtn')) {
            document.getElementById('backBtn').addEventListener('click', function() {
                document.querySelector('.sidebar').classList.remove('hidden');
            });
        }

        // Hide sidebar on mobile when chat is selected
        if (window.innerWidth <= 768) {
            document.querySelector('.sidebar').classList.add('hidden');
        }

        // Reconnect to peer if not connected
        if (PeerManager.getConnectedPeers(roomCode) === 0) {
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
        msgs.forEach(function(msg, idx) {
            if (msg.deleted) {
                // Show deleted placeholder
                var isMine = msg.sender === account.peerId;
                var cls = isMine ? 'msg msg-sent msg-deleted' : 'msg msg-received msg-deleted';
                html += '<div class="' + cls + '"><em>🚫 This message was deleted</em></div>';
                return;
            }
            var isMine = msg.sender === account.peerId;
            var cls = isMine ? 'msg msg-sent' : 'msg msg-received';
            html += '<div class="' + cls + '" data-msg-idx="' + idx + '">';
            if (!isMine) html += '<div class="msg-sender">' + escapeHtml(msg.senderName || 'Unknown') + '</div>';
            if (msg.location) {
                var mapLink = 'https://www.google.com/maps?q=' + msg.location.lat + ',' + msg.location.lng;
                html += '<div class="msg-location"><a href="' + mapLink + '" target="_blank" style="color:#667eea;text-decoration:none;">📍 ' + (msg.location.live ? 'Live location' : 'Location') + ' (' + msg.location.lat.toFixed(4) + ', ' + msg.location.lng.toFixed(4) + ')</a></div>';
            } else if (msg.media) {
                if (msg.mediaType && msg.mediaType.startsWith('video')) {
                    html += '<div class="msg-media"><video src="' + msg.media + '" controls></video></div>';
                } else {
                    html += '<div class="msg-media"><img src="' + msg.media + '"></div>';
                }
            }
            if (msg.text) html += '<div>' + escapeHtml(msg.text) + '</div>';
            var checkMark = '';
            if (isMine) {
                if (msg.read) {
                    checkMark = '<span class="msg-check read">✓✓</span>';
                } else if (msg.delivered) {
                    checkMark = '<span class="msg-check delivered">✓✓</span>';
                } else {
                    checkMark = '<span class="msg-check sent">✓</span>';
                }
            }
            html += '<div class="msg-time">' + formatTime(msg.timestamp) + ' ' + checkMark + '</div>';
            html += '</div>';
        });

        var container = document.getElementById('messages');
        container.innerHTML = html || '<p style="text-align:center;color:#636e72;margin-top:2rem;">No messages yet. Say hello!</p>';
        container.scrollTop = container.scrollHeight;

        // Attach context menu for delete (double-click/double-tap)
        container.querySelectorAll('.msg[data-msg-idx]').forEach(function(el) {
            el.addEventListener('dblclick', function(e) {
                e.preventDefault();
                showDeleteMenu(e, parseInt(el.dataset.msgIdx));
            });
        });
    }

    function showDeleteMenu(e, msgIdx) {
        // Remove existing menu
        var existing = document.getElementById('msgDeleteMenu');
        if (existing) existing.remove();

        var msgs = Storage.getMessages(currentRoom);
        var msg = msgs[msgIdx];
        if (!msg) return;

        var menu = document.createElement('div');
        menu.id = 'msgDeleteMenu';
        menu.className = 'msg-context-menu';
        menu.innerHTML =
            '<button class="ctx-btn" id="deleteForMe">🗑 Delete for me</button>' +
            (msg.sender === account.peerId ? '<button class="ctx-btn ctx-danger" id="deleteForAll">🗑 Delete for everyone</button>' : '') +
            '<button class="ctx-btn" id="cancelDelete">Cancel</button>';

        menu.style.position = 'fixed';
        menu.style.left = '50%';
        menu.style.top = '50%';
        menu.style.transform = 'translate(-50%, -50%)';
        document.body.appendChild(menu);

        document.getElementById('deleteForMe').addEventListener('click', function() {
            deleteMessageForMe(msgIdx);
            menu.remove();
        });

        if (document.getElementById('deleteForAll')) {
            document.getElementById('deleteForAll').addEventListener('click', function() {
                deleteMessageForAll(msgIdx);
                menu.remove();
            });
        }

        document.getElementById('cancelDelete').addEventListener('click', function() {
            menu.remove();
        });

        // Close on click outside
        setTimeout(function() {
            document.addEventListener('click', function closeMenu() {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            });
        }, 100);
    }

    function deleteMessageForMe(msgIdx) {
        var msgs = Storage.getMessages(currentRoom);
        msgs.splice(msgIdx, 1);
        localStorage.setItem('messenger_msgs_' + currentRoom, JSON.stringify(msgs));
        renderMessages(currentRoom);
    }

    function deleteMessageForAll(msgIdx) {
        var msgs = Storage.getMessages(currentRoom);
        var msg = msgs[msgIdx];
        if (!msg || !msg.msgId) return;

        // Mark as deleted locally
        msgs[msgIdx].deleted = true;
        msgs[msgIdx].text = '';
        msgs[msgIdx].media = null;
        msgs[msgIdx].location = null;
        localStorage.setItem('messenger_msgs_' + currentRoom, JSON.stringify(msgs));

        // Send delete signal to peers
        PeerManager.sendMessage(currentRoom, {
            type: 'delete',
            msgId: msg.msgId,
            roomCode: currentRoom,
            sender: account.peerId
        });

        renderMessages(currentRoom);
    }

    // Group invite with user picker
    function showInviteModal(roomCode, groupName) {
        var existing = document.getElementById('inviteModal');
        if (existing) existing.remove();

        // Get online users
        var onlineUsers = [];
        document.querySelectorAll('.online-user').forEach(function(el) {
            onlineUsers.push({ peerId: el.dataset.peer, name: el.dataset.name });
        });

        if (onlineUsers.length === 0) {
            alert('No other users online to invite.');
            return;
        }

        var modal = document.createElement('div');
        modal.id = 'inviteModal';
        modal.className = 'modal';
        modal.innerHTML =
            '<div class="modal-content">' +
            '<h2>Invite to ' + escapeHtml(groupName) + '</h2>' +
            '<p style="font-size:0.85rem;color:#636e72;margin-bottom:1rem;">Select users to invite:</p>' +
            '<div id="inviteUserList">' +
            onlineUsers.map(function(u) {
                return '<label style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;font-size:1rem;cursor:pointer;">' +
                    '<input type="checkbox" class="invite-check" data-peer="' + u.peerId + '" data-name="' + escapeHtml(u.name) + '"> ' +
                    escapeHtml(u.name) + '</label>';
            }).join('') +
            '</div>' +
            '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
            '<button id="sendInviteBtn" style="flex:1;">Send Invite</button>' +
            '<button id="cancelInviteBtn" class="modal-close" style="position:static;font-size:1rem;padding:0.6rem 1.2rem;">Cancel</button>' +
            '</div></div>';

        document.body.appendChild(modal);

        document.getElementById('sendInviteBtn').addEventListener('click', function() {
            var selected = document.querySelectorAll('.invite-check:checked');
            if (selected.length === 0) { alert('Select at least one user.'); return; }

            selected.forEach(function(cb) {
                var peerId = cb.dataset.peer;
                // Connect to peer and send invite
                PeerManager.connectToPeer(peerId, roomCode);
                // Send invite message after short delay for connection to establish
                setTimeout(function() {
                    PeerManager.sendMessage(roomCode, {
                        type: 'invite',
                        roomCode: roomCode,
                        groupName: groupName,
                        sender: account.peerId,
                        senderName: account.username,
                        invitedPeer: peerId
                    });
                }, 1500);
            });

            modal.remove();
            alert('Invite sent to ' + selected.length + ' user(s).');
        });

        document.getElementById('cancelInviteBtn').addEventListener('click', function() {
            modal.remove();
        });
    }

    // Handle incoming invites
    var pendingInvites = [];

    function handleInvite(data) {
        // Show invite notification
        var notification = document.createElement('div');
        notification.className = 'invite-notification';
        notification.innerHTML =
            '<div class="invite-content">' +
            '<strong>' + escapeHtml(data.senderName) + '</strong> invited you to join<br>' +
            '<span style="color:#667eea;font-weight:700;">' + escapeHtml(data.groupName) + '</span>' +
            '</div>' +
            '<div class="invite-actions">' +
            '<button class="invite-accept">Accept</button>' +
            '<button class="invite-decline">Decline</button>' +
            '</div>';

        document.body.appendChild(notification);

        notification.querySelector('.invite-accept').addEventListener('click', function() {
            // Add group to chat list
            var chat = {
                roomCode: data.roomCode,
                name: data.groupName,
                isGroup: true,
                joined: new Date().toISOString(),
                creatorPeerId: data.sender
            };
            Storage.addChat(chat);
            renderChatList();
            selectChat(data.roomCode);

            // Connect to the inviter
            PeerManager.connectToPeer(data.sender, data.roomCode);
            notification.remove();
        });

        notification.querySelector('.invite-decline').addEventListener('click', function() {
            notification.remove();
        });

        // Auto-dismiss after 30 seconds
        setTimeout(function() {
            if (notification.parentNode) notification.remove();
        }, 30000);
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
            timestamp: Date.now(),
            msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            delivered: false,
            read: false
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

        if (file.type.startsWith('image/')) {
            // Compress image before sending
            compressImage(file, function(dataUrl) {
                sendMediaMessage(dataUrl, file.type);
            });
        } else if (file.type.startsWith('video/')) {
            // Videos: limit to 5MB
            if (file.size > 5 * 1024 * 1024) {
                alert('Video too large. Max 5MB.');
                e.target.value = '';
                return;
            }
            var reader = new FileReader();
            reader.onload = function(ev) {
                sendMediaMessage(ev.target.result, file.type);
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });

    function compressImage(file, callback) {
        var img = new Image();
        img.onload = function() {
            var canvas = document.createElement('canvas');
            var maxSize = 800; // Max width/height
            var width = img.width;
            var height = img.height;

            if (width > maxSize || height > maxSize) {
                if (width > height) {
                    height = Math.round(height * maxSize / width);
                    width = maxSize;
                } else {
                    width = Math.round(width * maxSize / height);
                    height = maxSize;
                }
            }

            canvas.width = width;
            canvas.height = height;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            var dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            callback(dataUrl);
        };
        img.src = URL.createObjectURL(file);
    }

    function sendMediaMessage(dataUrl, mediaType) {
        var msg = {
            type: 'message',
            roomCode: currentRoom,
            sender: account.peerId,
            senderName: account.username,
            text: '',
            media: dataUrl,
            mediaType: mediaType,
            msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            delivered: false,
            read: false,
            timestamp: Date.now()
        };

        Storage.saveMessage(currentRoom, msg);
        PeerManager.sendMessage(currentRoom, msg);
        renderMessages(currentRoom);
        renderChatList();
    }

    // Location sharing
    var liveLocationInterval = null;
    var liveLocationActive = false;

    document.getElementById('locationBtn').addEventListener('click', function() {
        if (liveLocationActive) {
            stopLiveLocation();
        } else {
            showLocationMenu();
        }
    });

    function showLocationMenu() {
        var choice = confirm('Share live location?\n\nOK = Live location (updates while tab is open)\nCancel = Send current location once');
        if (choice) {
            startLiveLocation();
        } else {
            sendCurrentLocation();
        }
    }

    function sendCurrentLocation() {
        if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }
        navigator.geolocation.getCurrentPosition(function(pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            var mapUrl = 'https://www.google.com/maps?q=' + lat + ',' + lng;
            var msg = {
                type: 'message',
                roomCode: currentRoom,
                sender: account.peerId,
                senderName: account.username,
                text: '📍 Location: ' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '\n' + mapUrl,
                location: { lat: lat, lng: lng },
                msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                delivered: false,
                read: false,
                timestamp: Date.now()
            };
            Storage.saveMessage(currentRoom, msg);
            PeerManager.sendMessage(currentRoom, msg);
            renderMessages(currentRoom);
            renderChatList();
        }, function(err) {
            alert('Could not get location: ' + err.message);
        }, { enableHighAccuracy: true });
    }

    function startLiveLocation() {
        if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }
        liveLocationActive = true;
        document.getElementById('locationBtn').textContent = '📍✕';
        document.getElementById('locationBtn').title = 'Stop live location';

        // Send immediately
        sendLocationUpdate();

        // Update every 10 seconds
        liveLocationInterval = setInterval(function() {
            if (!document.hidden) {
                sendLocationUpdate();
            }
        }, 10000);
    }

    function stopLiveLocation() {
        liveLocationActive = false;
        liveLocationMsgId = null;
        if (liveLocationInterval) {
            clearInterval(liveLocationInterval);
            liveLocationInterval = null;
        }
        document.getElementById('locationBtn').textContent = '📍';
        document.getElementById('locationBtn').title = 'Share location';

        // Send stop message
        if (currentRoom) {
            var msg = {
                type: 'message',
                roomCode: currentRoom,
                sender: account.peerId,
                senderName: account.username,
                text: '📍 Live location ended',
                msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                delivered: false,
                read: false,
                timestamp: Date.now()
            };
            Storage.saveMessage(currentRoom, msg);
            PeerManager.sendMessage(currentRoom, msg);
            renderMessages(currentRoom);
            renderChatList();
        }
    }

    var liveLocationMsgId = null;

    function sendLocationUpdate() {
        if (!currentRoom || !liveLocationActive) return;
        navigator.geolocation.getCurrentPosition(function(pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            var mapUrl = 'https://www.google.com/maps?q=' + lat + ',' + lng;

            // Use same msgId to update existing message
            if (!liveLocationMsgId) {
                liveLocationMsgId = 'live-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
            }

            var msg = {
                type: 'message',
                roomCode: currentRoom,
                sender: account.peerId,
                senderName: account.username,
                text: '📍 Live location: ' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '\n' + mapUrl,
                location: { lat: lat, lng: lng, live: true },
                msgId: liveLocationMsgId,
                isLiveLocationUpdate: true,
                delivered: false,
                read: false,
                timestamp: Date.now()
            };

            // Update existing message in storage instead of adding new one
            var msgs = Storage.getMessages(currentRoom);
            var existingIdx = -1;
            for (var i = 0; i < msgs.length; i++) {
                if (msgs[i].msgId === liveLocationMsgId) {
                    existingIdx = i;
                    break;
                }
            }
            if (existingIdx >= 0) {
                msgs[existingIdx] = msg;
                localStorage.setItem('messenger_msgs_' + currentRoom, JSON.stringify(msgs));
            } else {
                Storage.saveMessage(currentRoom, msg);
            }

            PeerManager.sendMessage(currentRoom, msg);
            renderMessages(currentRoom);
        }, function() {}, { enableHighAccuracy: true });
    }

    // Resume live location when tab becomes visible
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden && liveLocationActive) {
            sendLocationUpdate();
        }
    });

    // Handle incoming messages
    // Unread message tracking

    function handleIncomingMessage(data) {
        if (data.type === 'message' && data.roomCode) {
            // Only process if it has content
            if (!data.sender || (!data.text && !data.media && !data.location)) return;

            // Deduplicate - skip if we already processed this message
            if (data.msgId && !data.isLiveLocationUpdate) {
                if (processedMsgIds[data.msgId]) return;
                processedMsgIds[data.msgId] = true;
            }

            // Live location update — replace existing message
            if (data.isLiveLocationUpdate && data.msgId) {
                var msgs = Storage.getMessages(data.roomCode);
                var existingIdx = -1;
                for (var i = 0; i < msgs.length; i++) {
                    if (msgs[i].msgId === data.msgId) {
                        existingIdx = i;
                        break;
                    }
                }
                if (existingIdx >= 0) {
                    msgs[existingIdx] = data;
                    localStorage.setItem('messenger_msgs_' + data.roomCode, JSON.stringify(msgs));
                } else {
                    Storage.saveMessage(data.roomCode, data);
                }
            } else {
                Storage.saveMessage(data.roomCode, data);
            }

            // Send delivery receipt
            if (data.msgId && data.sender !== account.peerId) {
                PeerManager.sendMessage(data.roomCode, {
                    type: 'receipt',
                    receiptType: 'delivered',
                    msgId: data.msgId,
                    roomCode: data.roomCode,
                    sender: account.peerId
                });
            }

            // Auto-add chat if we don't have it
            var chats = Storage.getChats();
            if (!chats.some(function(c) { return c.roomCode === data.roomCode; })) {
                var chatName = data.senderName || 'Chat';
                var isGroup = data.roomCode.indexOf('DM.') !== 0;
                Storage.addChat({
                    roomCode: data.roomCode,
                    name: chatName,
                    isGroup: isGroup,
                    directPeer: data.sender
                });
            }

            if (currentRoom === data.roomCode) {
                renderMessages(data.roomCode);
                // Send read receipt since chat is open
                if (data.msgId && data.sender !== account.peerId) {
                    PeerManager.sendMessage(data.roomCode, {
                        type: 'receipt',
                        receiptType: 'read',
                        msgId: data.msgId,
                        roomCode: data.roomCode,
                        sender: account.peerId
                    });
                }
            } else {
                // Mark as unread
                unreadCounts[data.roomCode] = (unreadCounts[data.roomCode] || 0) + 1;
            }

            // Update page title with total unread
            updateTitleBadge();
            renderChatList();
        } else if (data.type === 'invite') {
            // Handle group invite
            if (data.invitedPeer === account.peerId || !data.invitedPeer) {
                handleInvite(data);
            }
        } else if (data.type === 'delete') {
            // Handle delete for everyone
            if (data.msgId && data.roomCode) {
                var msgs = Storage.getMessages(data.roomCode);
                for (var i = 0; i < msgs.length; i++) {
                    if (msgs[i].msgId === data.msgId) {
                        msgs[i].deleted = true;
                        msgs[i].text = '';
                        msgs[i].media = null;
                        msgs[i].location = null;
                        break;
                    }
                }
                localStorage.setItem('messenger_msgs_' + data.roomCode, JSON.stringify(msgs));
                if (currentRoom === data.roomCode) {
                    renderMessages(data.roomCode);
                }
            }
        } else if (data.type === 'receipt') {
            // Update message status
            var msgs = Storage.getMessages(data.roomCode);
            var updated = false;
            for (var i = 0; i < msgs.length; i++) {
                if (msgs[i].msgId === data.msgId) {
                    if (data.receiptType === 'delivered') {
                        msgs[i].delivered = true;
                    } else if (data.receiptType === 'read') {
                        msgs[i].delivered = true;
                        msgs[i].read = true;
                    }
                    updated = true;
                    break;
                }
            }
            if (updated) {
                localStorage.setItem('messenger_msgs_' + data.roomCode, JSON.stringify(msgs));
                if (currentRoom === data.roomCode) {
                    renderMessages(data.roomCode);
                }
            }
        }
    }

    function updateTitleBadge() {
        var total = 0;
        for (var room in unreadCounts) {
            total += unreadCounts[room];
        }
        document.title = total > 0 ? '(' + total + ') Toki' : 'Toki';
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
