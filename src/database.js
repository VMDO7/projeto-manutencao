import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
})

// Executa várias consultas como uma única transação: ou tudo é confirmado, ou nada.
export async function emTransacao(funcao) {
    const conexao = await pool.connect()

    try {
        await conexao.query('BEGIN')
        const resultado = await funcao(conexao)
        await conexao.query('COMMIT')
        return resultado
    } catch (erro) {
        await conexao.query('ROLLBACK').catch(() => {})
        throw erro
    } finally {
        conexao.release()
    }
}

export default pool
