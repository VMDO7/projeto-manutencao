import 'dotenv/config'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import pool from './database.js'
import routes from './routes.js'
import { rotaNaoEncontrada, tratarErros } from './erros.js'

const pastaPublica = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

if (!process.env.JWT_SECRET) {
    console.error('Defina JWT_SECRET no arquivo .env antes de iniciar o servidor.')
    process.exit(1)
}

const app = express()

app.disable('x-powered-by')
app.use(express.json())

// RF01: a tela de acesso também responde em /login.
app.get('/login', (req, res) => {
    res.sendFile(path.join(pastaPublica, 'login.html'))
})

app.use(express.static(pastaPublica))

app.get('/api/status', (req, res) => {
    res.json({
        mensagem: 'Sistema Comercial funcionando'
    })
})

app.use('/api', routes)
app.use('/api', rotaNaoEncontrada)
app.use(tratarErros)

// RNF03: sem PORT no .env, escuta a 8080.
const PORT = Number(process.env.PORT) || 8080

// RNF07: com HTTPS_KEY e HTTPS_CERT no .env, o servidor sobe em HTTPS.
function criarServidor() {
    const { HTTPS_KEY, HTTPS_CERT } = process.env

    if (HTTPS_KEY && HTTPS_CERT) {
        return {
            protocolo: 'https',
            servidor: https.createServer(
                { key: fs.readFileSync(HTTPS_KEY), cert: fs.readFileSync(HTTPS_CERT) },
                app
            )
        }
    }

    console.warn('HTTPS_KEY/HTTPS_CERT não definidos: servidor em HTTP (use apenas em desenvolvimento).')
    return { protocolo: 'http', servidor: http.createServer(app) }
}

// RNF01: só abre a porta depois de confirmar o banco.
pool.query('SELECT NOW()')
    .then(() => {
        console.log('Banco de dados conectado')

        const { protocolo, servidor } = criarServidor()

        servidor.listen(PORT, () => {
            console.log(`Servidor rodando em ${protocolo}://localhost:${PORT}`)
        })
    })
    .catch(async (erro) => {
        // Conexão recusada chega como AggregateError, sem texto em message.
        console.error('Erro ao conectar ao banco:', erro.message || erro.code || String(erro))
        await pool.end().catch(() => {})
        process.exitCode = 1
    })
