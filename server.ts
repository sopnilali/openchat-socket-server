import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server, Socket } from 'socket.io'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

import { Prisma, PrismaClient } from '@prisma/client'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const globalForPrisma = globalThis as unknown as {
  chatServicePrisma: PrismaClient | undefined
}

function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL?.trim()
  if (!envUrl) {
    throw new Error(
      'DATABASE_URL is not set. Use the same Postgres URL as openchat (see .env.example).'
    )
  }
  return envUrl
}

/** Postgres (Neon): small pool + longer wait so Next + chat service do not exhaust Neon. */
function withPostgresPoolHints(url: string): string {
  if (!url.startsWith('postgresql')) {
    return url
  }
  try {
    const u = new URL(url)
    if (!u.searchParams.has('connection_limit')) {
      u.searchParams.set('connection_limit', '5')
    }
    if (!u.searchParams.has('pool_timeout')) {
      u.searchParams.set('pool_timeout', '60')
    }
    if (!u.searchParams.has('connect_timeout')) {
      u.searchParams.set('connect_timeout', '60')
    }
    if (u.hostname.includes('neon.tech') && !u.searchParams.has('pgbouncer')) {
      u.searchParams.set('pgbouncer', 'true')
    }
    return u.toString()
  } catch {
    return url
  }
}

function getDatasourceUrl(): string {
  return withPostgresPoolHints(resolveDatabaseUrl())
}

const db =
  globalForPrisma.chatServicePrisma ??
  new PrismaClient({
    datasources: {
      db: {
        url: getDatasourceUrl(),
      },
    },
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

globalForPrisma.chatServicePrisma = db

const INTERNAL_SECRET = process.env.CHAT_INTERNAL_SECRET || 'openchat-dev-internal'

/** Same payload as socket path — used by Next API so recipients update even if sender socket missed. */
function broadcastMessageUnsent(messageId: string, senderId: string, receiverId: string) {
  const payload = { messageId }
  io.to(`user:${senderId}`).emit('message-unsent', payload)
  io.to(`user:${receiverId}`).emit('message-unsent', payload)
}

function handleBroadcastUnsent(req: IncomingMessage, res: ServerResponse) {
  const header = req.headers['x-chat-internal']
  const token = Array.isArray(header) ? header[0] : header
  if (token !== INTERNAL_SECRET) {
    res.writeHead(403).end('Forbidden')
    return
  }
  let raw = ''
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString()
    if (raw.length > 8192) {
      req.destroy()
    }
  })
  req.on('end', () => {
    try {
      const body = JSON.parse(raw || '{}') as {
        messageId?: string
        senderId?: string
        receiverId?: string
      }
      if (!body.messageId || !body.senderId || !body.receiverId) {
        res.writeHead(400).end()
        return
      }
      broadcastMessageUnsent(body.messageId, body.senderId, body.receiverId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch {
      res.writeHead(400).end()
    }
  })
  req.on('error', () => {
    res.destroy()
  })
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = req.url?.split('?')[0] ?? ''

  if (req.method === 'POST' && path === '/broadcast-unsent') {
    handleBroadcastUnsent(req, res)
    return
  }

  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  if (path.startsWith('/socket.io')) {
    return
  }

  res.writeHead(404).end()
})

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true,
})

interface User {
  id: string
  username: string
  socketId: string
}

interface MessageData {
  id: string
  senderId: string
  receiverId: string
  content: string
  conversationId: string
  timestamp: Date
  status: string
}

interface TypingData {
  senderId: string
  receiverId: string
  isTyping: boolean
}

const connectedUsers = new Map<string, User>()

async function areUsersFriends(userA: string, userB: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "Friendship"
    WHERE status = 'accepted'
      AND (
        ("requesterId" = ${userA} AND "addresseeId" = ${userB})
        OR
        ("requesterId" = ${userB} AND "addresseeId" = ${userA})
      )
    LIMIT 1
  `)
  return rows.length > 0
}

// Helper to get all socket IDs for a user
function getSocketIdsByUserId(userId: string): string[] {
  const socketIds: string[] = []
  for (const [socketId, user] of connectedUsers) {
    if (user.id === userId) {
      socketIds.push(socketId)
    }
  }
  return socketIds
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`)

  // User joins with their user ID
  socket.on('join', async (data: { userId: string; username: string }) => {
    const { userId, username } = data

    // Room per user id so broadcasts (e.g. unsend) reach all tabs reliably
    await socket.join(`user:${userId}`)

    // Store user connection
    connectedUsers.set(socket.id, {
      id: userId,
      username,
      socketId: socket.id,
    })

    // Update user status to online in database
    try {
      await db.user.update({
        where: { id: userId },
        data: { status: 'online' },
      })
    } catch (error) {
      console.error('Error updating user status:', error)
    }

    // Broadcast to all users that this user is online
    io.emit('user-status', {
      userId,
      status: 'online',
    })

    // Send online users list to the newly connected user
    const onlineUsers = Array.from(connectedUsers.values()).filter(u => u.id !== userId)
    socket.emit('online-users', { users: onlineUsers })

    console.log(`${username} joined, current online users: ${connectedUsers.size}`)
  })

  // Handle new message (last arg = optional ack so client knows persist succeeded)
  socket.on('message', async (data: MessageData, ack?: (r: { ok: boolean; error?: string }) => void) => {
    const { senderId, receiverId, content } = data

    const reply = (r: { ok: boolean; error?: string }) => {
      if (typeof ack === 'function') {
        try {
          ack(r)
        } catch (e) {
          console.error('message ack error:', e)
        }
      }
    }

    try {
      const isFriend = await areUsersFriends(senderId, receiverId)
      if (!isFriend) {
        socket.emit('message-error', { error: 'Only friends can chat' })
        reply({ ok: false, error: 'Only friends can chat' })
        return
      }

      // Find or create conversation
      let conversation = await db.conversation.findFirst({
        where: {
          OR: [
            { participants: JSON.stringify([senderId, receiverId]) },
            { participants: JSON.stringify([receiverId, senderId]) },
          ],
        },
      })

      if (!conversation) {
        conversation = await db.conversation.create({
          data: {
            participants: JSON.stringify([senderId, receiverId]),
          },
        })
      }

      // Create message in database
      const message = await db.message.create({
        data: {
          senderId,
          receiverId,
          content,
          conversationId: conversation.id,
          status: 'sent',
        },
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              avatarUrl: true,
            },
          },
          receiver: {
            select: {
              id: true,
              username: true,
              avatarUrl: true,
            },
          },
        },
      })

      // Update conversation
      await db.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageId: message.id,
          updatedAt: new Date(),
        },
      })

      reply({ ok: true })

      // Send to receiver's sockets
      const receiverSocketIds = getSocketIdsByUserId(receiverId)
      receiverSocketIds.forEach(socketId => {
        io.to(socketId).emit('message', message)
      })

      // Also send back to sender for confirmation with the real conversation ID
      socket.emit('message-sent', {
        ...message,
        conversationId: conversation.id,
      })

      console.log(`Message from ${senderId} to ${receiverId}: ${content}`)
    } catch (error) {
      console.error('Error saving message:', error)
      socket.emit('message-error', { error: 'Failed to send message' })
      reply({ ok: false, error: 'Failed to send message' })
    }
  })

  // Handle typing indicator
  socket.on('typing', (data: TypingData) => {
    const { senderId, receiverId, isTyping } = data

    // Send typing status to receiver
    const receiverSocketIds = getSocketIdsByUserId(receiverId)
    receiverSocketIds.forEach(socketId => {
      io.to(socketId).emit('typing', {
        senderId,
        isTyping,
      })
    })
  })

  // Handle message seen
  socket.on('seen', async (data: { messageIds: string[]; senderId: string }) => {
    const { messageIds, senderId } = data

    try {
      // Update messages status to seen
      await db.message.updateMany({
        where: {
          id: { in: messageIds },
          senderId: senderId,
        },
        data: { status: 'seen' },
      })

      // Notify sender that messages were seen
      const senderSocketIds = getSocketIdsByUserId(senderId)
      senderSocketIds.forEach(socketId => {
        io.to(socketId).emit('messages-seen', {
          messageIds,
          seenAt: new Date(),
        })
      })
    } catch (error) {
      console.error('Error updating message status:', error)
    }
  })

  // Handle unsend (replace with unsent placeholder for everyone)
  socket.on('delete-message', async (data: { messageId: string; userId: string }) => {
    const { messageId, userId } = data

    try {
      const message = await db.message.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          senderId: true,
          receiverId: true,
        },
      })

      if (!message) {
        socket.emit('message-error', { error: 'Message not found' })
        return
      }

      if (message.senderId !== userId) {
        socket.emit('message-error', { error: 'Only sender can unsend message' })
        return
      }

      await db.message.update({
        where: { id: messageId },
        data: {
          content: 'This message was unsent',
          status: 'unsent',
        },
      })

      broadcastMessageUnsent(messageId, message.senderId, message.receiverId)
    } catch (error) {
      console.error('Error deleting message for everyone:', error)
      socket.emit('message-error', { error: 'Failed to unsend message' })
    }
  })

  // Handle disconnect
  socket.on('disconnect', async () => {
    const user = connectedUsers.get(socket.id)

    if (user) {
      // Remove from connected users
      connectedUsers.delete(socket.id)

      // Update user status to offline in database
      try {
        await db.user.update({
          where: { id: user.id },
          data: { status: 'offline' },
        })
      } catch (error) {
        console.error('Error updating user status on disconnect:', error)
      }

      // Broadcast to all users that this user is offline
      io.emit('user-status', {
        userId: user.id,
        status: 'offline',
      })

      console.log(`${user.username} disconnected, current online users: ${connectedUsers.size}`)
    } else {
      console.log(`User disconnected: ${socket.id}`)
    }
  })

  // Handle errors
  socket.on('error', (error) => {
    console.error(`Socket error (${socket.id}):`, error)
  })
})

const listenPort = Number(process.env.PORT || process.env.CHAT_PORT || 3003)
const listenHost = process.env.LISTEN_HOST || '0.0.0.0'
httpServer.listen(listenPort, listenHost, () => {
  console.log(`Chat server on http://${listenHost}:${listenPort} (Socket.IO + POST /broadcast-unsent)`)
})

// Graceful shutdown
function shutdown() {
  void db.$disconnect().then(() => {
    httpServer.close(() => {
      console.log('WebSocket server closed')
      process.exit(0)
    })
  })
}

process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal, shutting down server...')
  shutdown()
})

process.on('SIGINT', () => {
  console.log('Received SIGINT signal, shutting down server...')
  shutdown()
})
