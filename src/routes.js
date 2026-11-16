import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool, { emTransacao } from './database.js'
import { autenticar, exigirPerfil } from './auth.js'
import { ErroApi } from './erros.js'

const router = express.Router()

const somenteAdmin = exigirPerfil('admin')

const VALOR_MINIMO_PEDIDO_CENTAVOS = 5000
const PRECO_MAXIMO = 99999999.99 // limite de NUMERIC(10,2)

// Transições aceitas em PUT /pedidos/:id/status (o cancelamento tem rota própria).
const PROXIMO_STATUS = {
    rascunho: ['confirmado'],
    confirmado: ['pago'],
    pago: ['entregue']
}
const STATUS_PEDIDO = ['rascunho', 'confirmado', 'pago', 'entregue', 'cancelado']
const STATUS_CANCELAVEIS = ['rascunho', 'confirmado']

/* ---------- utilitários ---------- */

function texto(valor) {
    return typeof valor === 'string' ? valor.trim() : ''
}

function lerId(valor, rotulo = 'Identificador') {
    const id = Number(valor)

    if (!Number.isInteger(id) || id <= 0) {
        throw new ErroApi(400, `${rotulo} inválido`)
    }

    return id
}

// RNF04: page e limit, 10 registros por padrão.
function lerPaginacao(query) {
    const pagina = Math.max(1, Number.parseInt(query.page, 10) || 1)
    const limite = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 10))

    return { pagina, limite, offset: (pagina - 1) * limite }
}

function respostaPaginada(linhas, total, { pagina, limite }) {
    return {
        dados: linhas,
        pagina,
        limite,
        total,
        total_paginas: Math.max(1, Math.ceil(total / limite))
    }
}

// RNF06: toda inclusão, alteração e exclusão deixa rastro.
async function auditar(executor, req, acao, detalhe) {
    await executor.query(
        `INSERT INTO auditoria (id_usuario, acao, detalhe)
         VALUES ($1, $2, $3)`,
        [req.usuario.id_usuario, acao, detalhe]
    )
}

function centavosParaTexto(centavos) {
    return (centavos / 100).toFixed(2)
}

/* ---------- login ---------- */

router.post('/login', async (req, res) => {
    const email = texto(req.body?.email)
    const senha = typeof req.body?.senha === 'string' ? req.body.senha : ''

    if (!email || !senha) {
        throw new ErroApi(400, 'Informe e-mail e senha')
    }

    const resultado = await pool.query(
        'SELECT * FROM usuarios WHERE email = $1 AND ativo = TRUE',
        [email]
    )

    const usuario = resultado.rows[0]
    const senhaCorreta = usuario
        ? await bcrypt.compare(senha, usuario.senha_hash)
        : false

    // Mesma mensagem para e-mail e senha errados, para não revelar qual falhou.
    if (!senhaCorreta) {
        throw new ErroApi(401, 'Usuário ou senha inválidos')
    }

    const token = jwt.sign(
        {
            id_usuario: usuario.id_usuario,
            nome: usuario.nome,
            perfil: usuario.perfil
        },
        process.env.JWT_SECRET,
        { expiresIn: '2h' }
    )

    res.json({
        mensagem: 'Login realizado',
        token,
        usuario: {
            id_usuario: usuario.id_usuario,
            nome: usuario.nome,
            email: usuario.email,
            perfil: usuario.perfil
        }
    })
})

// Daqui para baixo, todas as rotas exigem token.
router.use(autenticar)

/* ---------- painel ---------- */

router.get('/painel', async (req, res) => {
    const resultado = await pool.query(
        `SELECT
            (SELECT COUNT(*) FROM clientes)::int AS total_clientes,
            (SELECT COUNT(*) FROM produtos WHERE ativo = TRUE AND estoque > 0)::int AS produtos_em_estoque,
            (SELECT COALESCE(SUM(valor_total), 0)
               FROM pedidos
              WHERE status IN ('pago', 'entregue')
                AND data_pedido >= date_trunc('month', CURRENT_DATE)
                AND data_pedido < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
            ) AS faturamento_mes`
    )

    res.json(resultado.rows[0])
})

/* ---------- clientes ---------- */

function validarCliente(corpo = {}) {
    const dados = {
        nome: texto(corpo.nome),
        email: texto(corpo.email),
        telefone: texto(corpo.telefone) || null,
        cpf_cnpj: texto(corpo.cpf_cnpj)
    }

    if (!dados.nome || !dados.email || !dados.cpf_cnpj) {
        throw new ErroApi(400, 'Informe nome, e-mail e CPF/CNPJ')
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) {
        throw new ErroApi(400, 'E-mail inválido')
    }

    if (!/^(\d{11}|\d{14})$/.test(dados.cpf_cnpj)) {
        throw new ErroApi(400, 'O CPF deve ter 11 dígitos e o CNPJ 14 dígitos, somente números')
    }

    return dados
}

function traduzirDuplicidadeCliente(erro) {
    if (erro.code === '23505') {
        if (erro.constraint === 'clientes_email_key') {
            return new ErroApi(409, 'Já existe um cliente com este e-mail')
        }
        if (erro.constraint === 'clientes_cpf_cnpj_key') {
            return new ErroApi(409, 'Já existe um cliente com este CPF/CNPJ')
        }
    }
    return erro
}

router.get('/clientes', async (req, res) => {
    const paginacao = lerPaginacao(req.query)

    const [linhas, total] = await Promise.all([
        pool.query(
            `SELECT * FROM clientes
             ORDER BY data_cadastro, id_cliente
             LIMIT $1 OFFSET $2`,
            [paginacao.limite, paginacao.offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM clientes')
    ])

    res.json(respostaPaginada(linhas.rows, total.rows[0].total, paginacao))
})

router.post('/clientes', async (req, res) => {
    const dados = validarCliente(req.body)

    try {
        const cliente = await emTransacao(async (conexao) => {
            const resultado = await conexao.query(
                `INSERT INTO clientes (nome, email, telefone, cpf_cnpj)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [dados.nome, dados.email, dados.telefone, dados.cpf_cnpj]
            )
            const novo = resultado.rows[0]

            await auditar(conexao, req, 'cliente_cadastrado', `Cliente ${novo.id_cliente} - ${novo.nome}`)

            return novo
        })

        res.status(201).json(cliente)
    } catch (erro) {
        throw traduzirDuplicidadeCliente(erro)
    }
})

router.put('/clientes/:id', async (req, res) => {
    const id = lerId(req.params.id, 'Cliente')
    const dados = validarCliente(req.body)

    try {
        const cliente = await emTransacao(async (conexao) => {
            const resultado = await conexao.query(
                `UPDATE clientes
                 SET nome = $1, email = $2, telefone = $3, cpf_cnpj = $4
                 WHERE id_cliente = $5
                 RETURNING *`,
                [dados.nome, dados.email, dados.telefone, dados.cpf_cnpj, id]
            )

            if (resultado.rows.length === 0) {
                throw new ErroApi(404, 'Cliente não encontrado')
            }

            await auditar(conexao, req, 'cliente_alterado', `Cliente ${id} - ${dados.nome}`)

            return resultado.rows[0]
        })

        res.json(cliente)
    } catch (erro) {
        throw traduzirDuplicidadeCliente(erro)
    }
})

router.delete('/clientes/:id', somenteAdmin, async (req, res) => {
    const id = lerId(req.params.id, 'Cliente')

    const pedidosRemovidos = await emTransacao(async (conexao) => {
        const cliente = await conexao.query(
            'SELECT id_cliente, nome FROM clientes WHERE id_cliente = $1 FOR UPDATE',
            [id]
        )

        if (cliente.rows.length === 0) {
            throw new ErroApi(404, 'Cliente não encontrado')
        }

        // Pedidos que ainda não saíram da loja devolvem os produtos ao estoque antes de sumir.
        await conexao.query(
            `UPDATE produtos p
             SET estoque = p.estoque + s.quantidade
             FROM (
                SELECT i.id_produto, SUM(i.quantidade) AS quantidade
                FROM itens_pedido i
                INNER JOIN pedidos pe ON pe.id_pedido = i.id_pedido
                WHERE pe.id_cliente = $1 AND pe.status = ANY($2)
                GROUP BY i.id_produto
             ) s
             WHERE p.id_produto = s.id_produto`,
            [id, STATUS_CANCELAVEIS]
        )

        const pedidos = await conexao.query(
            'SELECT COUNT(*)::int AS total FROM pedidos WHERE id_cliente = $1',
            [id]
        )

        // ON DELETE CASCADE remove os pedidos e, em seguida, os itens.
        await conexao.query('DELETE FROM clientes WHERE id_cliente = $1', [id])

        await auditar(
            conexao,
            req,
            'cliente_excluido',
            `Cliente ${id} - ${cliente.rows[0].nome} (${pedidos.rows[0].total} pedido(s) removido(s))`
        )

        return pedidos.rows[0].total
    })

    res.json({
        mensagem: 'Cliente excluído',
        pedidos_removidos: pedidosRemovidos
    })
})

/* ---------- produtos ---------- */

function validarProduto(corpo = {}) {
    const nome = texto(corpo.nome)
    const descricao = texto(corpo.descricao) || null
    const preco = Number(corpo.preco)
    const estoque = Number(corpo.estoque)

    if (!nome) {
        throw new ErroApi(400, 'Informe o nome do produto')
    }

    if (corpo.preco === '' || corpo.preco == null || !Number.isFinite(preco) || preco <= 0 || preco > PRECO_MAXIMO) {
        throw new ErroApi(400, 'O preço precisa ser maior que zero')
    }

    if (corpo.estoque === '' || corpo.estoque == null || !Number.isInteger(estoque)) {
        throw new ErroApi(400, 'O estoque precisa ser um número inteiro')
    }

    return { nome, descricao, preco: preco.toFixed(2), estoque }
}

router.get('/produtos', async (req, res) => {
    const paginacao = lerPaginacao(req.query)

    const [linhas, total] = await Promise.all([
        pool.query(
            `SELECT * FROM produtos
             WHERE ativo = TRUE
             ORDER BY id_produto
             LIMIT $1 OFFSET $2`,
            [paginacao.limite, paginacao.offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM produtos WHERE ativo = TRUE')
    ])

    res.json(respostaPaginada(linhas.rows, total.rows[0].total, paginacao))
})

router.post('/produtos', async (req, res) => {
    const dados = validarProduto(req.body)

    const produto = await emTransacao(async (conexao) => {
        const resultado = await conexao.query(
            `INSERT INTO produtos (nome, descricao, preco, estoque)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [dados.nome, dados.descricao, dados.preco, dados.estoque]
        )
        const novo = resultado.rows[0]

        await auditar(conexao, req, 'produto_cadastrado', `Produto ${novo.id_produto} - ${novo.nome}`)

        return novo
    })

    res.status(201).json(produto)
})

router.put('/produtos/:id', async (req, res) => {
    const id = lerId(req.params.id, 'Produto')
    const dados = validarProduto(req.body)

    const produto = await emTransacao(async (conexao) => {
        const resultado = await conexao.query(
            `UPDATE produtos
             SET nome = $1, descricao = $2, preco = $3, estoque = $4
             WHERE id_produto = $5 AND ativo = TRUE
             RETURNING *`,
            [dados.nome, dados.descricao, dados.preco, dados.estoque, id]
        )

        if (resultado.rows.length === 0) {
            throw new ErroApi(404, 'Produto não encontrado')
        }

        await auditar(conexao, req, 'produto_alterado', `Produto ${id} - ${dados.nome}`)

        return resultado.rows[0]
    })

    res.json(produto)
})

// Desativa em vez de apagar: o produto pode estar em pedidos antigos (RN03).
router.delete('/produtos/:id', somenteAdmin, async (req, res) => {
    const id = lerId(req.params.id, 'Produto')

    await emTransacao(async (conexao) => {
        const resultado = await conexao.query(
            `UPDATE produtos
             SET ativo = FALSE
             WHERE id_produto = $1 AND ativo = TRUE
             RETURNING nome`,
            [id]
        )

        if (resultado.rows.length === 0) {
            throw new ErroApi(404, 'Produto não encontrado')
        }

        await auditar(conexao, req, 'produto_desativado', `Produto ${id} - ${resultado.rows[0].nome}`)
    })

    res.json({
        mensagem: 'Produto desativado'
    })
})

/* ---------- pedidos ---------- */

router.get('/pedidos', async (req, res) => {
    const paginacao = lerPaginacao(req.query)

    const [linhas, total] = await Promise.all([
        pool.query(
            `SELECT
                p.id_pedido,
                p.data_pedido,
                p.status,
                p.valor_total,
                c.nome AS cliente,
                u.nome AS usuario
             FROM pedidos p
             INNER JOIN clientes c ON p.id_cliente = c.id_cliente
             INNER JOIN usuarios u ON p.id_usuario = u.id_usuario
             ORDER BY p.data_pedido DESC, p.id_pedido DESC
             LIMIT $1 OFFSET $2`,
            [paginacao.limite, paginacao.offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM pedidos')
    ])

    res.json(respostaPaginada(linhas.rows, total.rows[0].total, paginacao))
})

router.get('/pedidos/:id', async (req, res) => {
    const id = lerId(req.params.id, 'Pedido')

    const pedido = await pool.query(
        `SELECT
            p.*,
            c.nome AS cliente,
            u.nome AS usuario
         FROM pedidos p
         INNER JOIN clientes c ON p.id_cliente = c.id_cliente
         INNER JOIN usuarios u ON p.id_usuario = u.id_usuario
         WHERE p.id_pedido = $1`,
        [id]
    )

    if (pedido.rows.length === 0) {
        throw new ErroApi(404, 'Pedido não encontrado')
    }

    const itens = await pool.query(
        `SELECT
            i.id_item,
            i.id_produto,
            pr.nome AS produto,
            i.quantidade,
            i.preco_unitario,
            i.subtotal
         FROM itens_pedido i
         INNER JOIN produtos pr ON i.id_produto = pr.id_produto
         WHERE i.id_pedido = $1
         ORDER BY i.id_item`,
        [id]
    )

    res.json({
        pedido: pedido.rows[0],
        itens: itens.rows
    })
})

router.post('/pedidos', async (req, res) => {
    const { id_cliente, itens } = req.body || {}

    if (!id_cliente || !Array.isArray(itens) || itens.length === 0) {
        throw new ErroApi(400, 'Informe o cliente e pelo menos um produto')
    }

    const idCliente = lerId(id_cliente, 'Cliente')
    const quantidades = new Map()

    for (const item of itens) {
        const idProduto = Number(item?.id_produto)
        const quantidade = Number(item?.quantidade)

        if (!Number.isInteger(idProduto) || idProduto <= 0 || !Number.isInteger(quantidade) || quantidade <= 0) {
            throw new ErroApi(400, 'Produto ou quantidade inválidos')
        }

        if (quantidades.has(idProduto)) {
            throw new ErroApi(409, `O produto ${idProduto} foi incluído mais de uma vez no pedido`)
        }

        quantidades.set(idProduto, quantidade)
    }

    const pedido = await emTransacao(async (conexao) => {
        const cliente = await conexao.query(
            'SELECT id_cliente FROM clientes WHERE id_cliente = $1',
            [idCliente]
        )

        if (cliente.rows.length === 0) {
            throw new ErroApi(404, 'Cliente não encontrado')
        }

        // Ordenar por id evita deadlock quando dois pedidos travam os mesmos produtos.
        const linhas = []
        let totalCentavos = 0

        for (const [idProduto, quantidade] of [...quantidades].sort((a, b) => a[0] - b[0])) {
            const produto = await conexao.query(
                `SELECT id_produto, nome, preco, ativo
                 FROM produtos
                 WHERE id_produto = $1
                 FOR UPDATE`,
                [idProduto]
            )

            if (produto.rows.length === 0) {
                throw new ErroApi(404, `Produto ${idProduto} não encontrado`)
            }

            const dadosProduto = produto.rows[0]

            if (!dadosProduto.ativo) {
                throw new ErroApi(400, `O produto ${dadosProduto.nome} está fora de linha`)
            }

            // RN05: não bloqueia por falta de saldo; o estoque pode ficar negativo.
            const precoCentavos = Math.round(Number(dadosProduto.preco) * 100)
            const subtotalCentavos = precoCentavos * quantidade

            totalCentavos += subtotalCentavos
            linhas.push({ idProduto, quantidade, precoCentavos, subtotalCentavos })
        }

        if (totalCentavos < VALOR_MINIMO_PEDIDO_CENTAVOS) {
            throw new ErroApi(400, 'O valor total mínimo do pedido é R$ 50,00')
        }

        const novoPedido = await conexao.query(
            `INSERT INTO pedidos (id_cliente, id_usuario, status, valor_total)
             VALUES ($1, $2, 'rascunho', $3)
             RETURNING id_pedido`,
            [idCliente, req.usuario.id_usuario, centavosParaTexto(totalCentavos)]
        )

        const idPedido = novoPedido.rows[0].id_pedido

        for (const linha of linhas) {
            await conexao.query(
                `INSERT INTO itens_pedido
                 (id_pedido, id_produto, quantidade, preco_unitario, subtotal)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    idPedido,
                    linha.idProduto,
                    linha.quantidade,
                    centavosParaTexto(linha.precoCentavos),
                    centavosParaTexto(linha.subtotalCentavos)
                ]
            )

            await conexao.query(
                'UPDATE produtos SET estoque = estoque - $1 WHERE id_produto = $2',
                [linha.quantidade, linha.idProduto]
            )
        }

        await auditar(
            conexao,
            req,
            'pedido_cadastrado',
            `Pedido ${idPedido} do cliente ${idCliente}, total R$ ${centavosParaTexto(totalCentavos)}`
        )

        return { id_pedido: idPedido, valor_total: centavosParaTexto(totalCentavos) }
    })

    res.status(201).json({
        mensagem: 'Pedido cadastrado com sucesso',
        ...pedido
    })
})

router.put('/pedidos/:id/status', async (req, res) => {
    const id = lerId(req.params.id, 'Pedido')
    const novoStatus = texto(req.body?.status)

    if (!STATUS_PEDIDO.includes(novoStatus)) {
        throw new ErroApi(400, `Status inválido. Use: ${STATUS_PEDIDO.join(', ')}`)
    }

    if (novoStatus === 'cancelado') {
        throw new ErroApi(400, 'Para cancelar, use a ação de cancelamento (DELETE /api/pedidos/:id)')
    }

    const pedido = await emTransacao(async (conexao) => {
        const atual = await conexao.query(
            'SELECT status FROM pedidos WHERE id_pedido = $1 FOR UPDATE',
            [id]
        )

        if (atual.rows.length === 0) {
            throw new ErroApi(404, 'Pedido não encontrado')
        }

        const statusAtual = atual.rows[0].status

        if (!(PROXIMO_STATUS[statusAtual] || []).includes(novoStatus)) {
            throw new ErroApi(400, `Não é possível mudar o pedido de "${statusAtual}" para "${novoStatus}"`)
        }

        const resultado = await conexao.query(
            'UPDATE pedidos SET status = $1 WHERE id_pedido = $2 RETURNING *',
            [novoStatus, id]
        )

        await auditar(conexao, req, 'pedido_status_alterado', `Pedido ${id}: ${statusAtual} -> ${novoStatus}`)

        return resultado.rows[0]
    })

    res.json(pedido)
})

router.delete('/pedidos/:id', somenteAdmin, async (req, res) => {
    const id = lerId(req.params.id, 'Pedido')

    await emTransacao(async (conexao) => {
        const pedido = await conexao.query(
            'SELECT status FROM pedidos WHERE id_pedido = $1 FOR UPDATE',
            [id]
        )

        if (pedido.rows.length === 0) {
            throw new ErroApi(404, 'Pedido não encontrado')
        }

        const status = pedido.rows[0].status

        if (status === 'cancelado') {
            throw new ErroApi(400, 'Este pedido já está cancelado')
        }

        if (!STATUS_CANCELAVEIS.includes(status)) {
            throw new ErroApi(400, `Pedido "${status}" não pode ser cancelado`)
        }

        // RN06: o cancelamento devolve as quantidades ao estoque.
        await conexao.query(
            `UPDATE produtos p
             SET estoque = p.estoque + i.quantidade
             FROM itens_pedido i
             WHERE i.id_pedido = $1 AND p.id_produto = i.id_produto`,
            [id]
        )

        await conexao.query(
            `UPDATE pedidos SET status = 'cancelado' WHERE id_pedido = $1`,
            [id]
        )

        await auditar(conexao, req, 'pedido_cancelado', `Pedido ${id} cancelado (estava ${status})`)
    })

    res.json({
        mensagem: 'Pedido cancelado e estoque atualizado'
    })
})

/* ---------- auditoria ---------- */

router.get('/auditoria', async (req, res) => {
    const paginacao = lerPaginacao(req.query)

    const [linhas, total] = await Promise.all([
        pool.query(
            `SELECT a.id_auditoria, a.acao, a.data_hora, a.detalhe, a.id_usuario, u.nome AS usuario
             FROM auditoria a
             LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
             ORDER BY a.data_hora DESC, a.id_auditoria DESC
             LIMIT $1 OFFSET $2`,
            [paginacao.limite, paginacao.offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM auditoria')
    ])

    res.json(respostaPaginada(linhas.rows, total.rows[0].total, paginacao))
})

export default router
