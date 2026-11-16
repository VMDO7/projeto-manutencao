import jwt from 'jsonwebtoken'

export function autenticar(req, res, next) {
    const [tipo, token] = (req.headers.authorization || '').split(' ')

    if (tipo !== 'Bearer' || !token) {
        return res.status(401).json({
            mensagem: 'Token não informado'
        })
    }

    try {
        req.usuario = jwt.verify(token, process.env.JWT_SECRET)

        next()
    } catch {
        return res.status(401).json({
            mensagem: 'Token inválido ou expirado'
        })
    }
}

// Libera a rota apenas para os perfis informados (RN01). Os demais recebem 403.
export function exigirPerfil(...perfis) {
    return function (req, res, next) {
        if (!perfis.includes(req.usuario?.perfil)) {
            return res.status(403).json({
                mensagem: 'Operação permitida somente para administradores'
            })
        }

        next()
    }
}

export default autenticar
