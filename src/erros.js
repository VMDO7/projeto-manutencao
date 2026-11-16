// Erro "esperado" da API: carrega o status HTTP e a mensagem que vai para a tela.
export class ErroApi extends Error {
    constructor(status, mensagem) {
        super(mensagem)
        this.status = status
    }
}

// Rotas /api que não existem respondem em JSON, e não com a página HTML padrão do Express.
export function rotaNaoEncontrada(req, res) {
    res.status(404).json({
        mensagem: 'Rota não encontrada'
    })
}

// Tratador central: toda rota pode simplesmente lançar um erro e ele chega aqui.
// eslint-disable-next-line no-unused-vars
export function tratarErros(erro, req, res, next) {
    if (erro instanceof ErroApi) {
        return res.status(erro.status).json({ mensagem: erro.message })
    }

    if (erro.type === 'entity.parse.failed') {
        return res.status(400).json({ mensagem: 'O corpo da requisição não é um JSON válido' })
    }

    // Violação de UNIQUE no PostgreSQL
    if (erro.code === '23505') {
        return res.status(409).json({ mensagem: 'Registro já cadastrado' })
    }

    console.error(erro)

    res.status(500).json({
        mensagem: 'Erro inesperado no servidor'
    })
}
