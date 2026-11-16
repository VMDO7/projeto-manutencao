const token = localStorage.getItem('token')
let usuario = null

try {
    usuario = JSON.parse(localStorage.getItem('usuario') || 'null')
} catch {
    usuario = null
}

const logado = Boolean(token && usuario)

if (!logado) {
    window.location.replace('login.html')
}

const ehAdmin = usuario?.perfil === 'admin'
const mensagem = document.getElementById('mensagem')

const VALOR_MINIMO_PEDIDO = 50
const STATUS_CANCELAVEIS = ['rascunho', 'confirmado']
const PROXIMA_ACAO = {
    rascunho: { status: 'confirmado', rotulo: 'Confirmar' },
    confirmado: { status: 'pago', rotulo: 'Registrar pagamento' },
    pago: { status: 'entregue', rotulo: 'Registrar entrega' }
}

// Página atual e linhas exibidas de cada listagem (usadas na edição sem nova consulta).
const estado = {
    clientes: { pagina: 1, dados: [] },
    produtos: { pagina: 1, dados: [] },
    pedidos: { pagina: 1 },
    auditoria: { pagina: 1 }
}

const itensPedido = []
let produtosDisponiveis = []

document.getElementById('nomeUsuario').textContent = usuario
    ? `Usuário: ${usuario.nome} (${usuario.perfil === 'admin' ? 'Administrador' : 'Funcionário'})`
    : ''

/* ---------- utilitários ---------- */

function escapar(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, function (caractere) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[caractere]
    })
}

function mostrarMensagem(texto, tipo = '') {
    mensagem.textContent = texto
    mensagem.className = `mensagem ${tipo}`.trim()
}

function encerrarSessao() {
    localStorage.removeItem('token')
    localStorage.removeItem('usuario')
    window.location.replace('login.html')
}

async function requisicao(url, metodo = 'GET', dados = null) {
    const opcoes = {
        method: metodo,
        headers: {
            'Authorization': `Bearer ${token}`
        }
    }

    if (dados !== null) {
        opcoes.headers['Content-Type'] = 'application/json'
        opcoes.body = JSON.stringify(dados)
    }

    const resposta = await fetch(url, opcoes)

    // Nem toda resposta de erro vem em JSON (ex.: servidor fora do ar atrás de um proxy).
    let resultado = null
    try {
        resultado = await resposta.json()
    } catch {
        resultado = null
    }

    if (resposta.status === 401) {
        encerrarSessao()
        throw new Error('Sessão expirada')
    }

    if (!resposta.ok) {
        throw new Error(resultado?.mensagem || `Erro na requisição (${resposta.status})`)
    }

    return resultado
}

// Percorre todas as páginas de uma listagem (usado para preencher os selects do pedido).
async function buscarTodos(url) {
    const todos = []
    let pagina = 1
    let totalPaginas = 1

    do {
        const resposta = await requisicao(`${url}?page=${pagina}&limit=100`)
        todos.push(...resposta.dados)
        totalPaginas = resposta.total_paginas
        pagina++
    } while (pagina <= totalPaginas)

    return todos
}

function formatarMoeda(valor) {
    return Number(valor).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    })
}

function formatarData(data) {
    return new Date(data).toLocaleDateString('pt-BR')
}

function formatarDataHora(data) {
    return new Date(data).toLocaleString('pt-BR')
}

function montarPaginacao(idContainer, resposta, aoMudarPagina) {
    const container = document.getElementById(idContainer)

    container.innerHTML = `
        <button type="button" class="btn-secundario" data-pagina="${resposta.pagina - 1}"
            ${resposta.pagina <= 1 ? 'disabled' : ''}>Anterior</button>
        <span>Página ${resposta.pagina} de ${resposta.total_paginas} · ${resposta.total} registro(s)</span>
        <button type="button" class="btn-secundario" data-pagina="${resposta.pagina + 1}"
            ${resposta.pagina >= resposta.total_paginas ? 'disabled' : ''}>Próxima</button>
    `

    container.onclick = function (event) {
        const pagina = event.target.dataset.pagina
        if (pagina && !event.target.disabled) aoMudarPagina(Number(pagina))
    }
}

// Busca uma página; se ela ficou vazia (ex.: último item excluído), volta para a última existente.
async function buscarPagina(url, pagina) {
    let resposta = await requisicao(`${url}?page=${pagina}`)

    if (resposta.dados.length === 0 && resposta.pagina > resposta.total_paginas) {
        resposta = await requisicao(`${url}?page=${resposta.total_paginas}`)
    }

    return resposta
}

/* ---------- navegação ---------- */

function abrirTela(nome) {
    document.querySelectorAll('.tela').forEach(function (tela) {
        tela.classList.add('escondido')
    })

    document.getElementById(nome).classList.remove('escondido')

    document.querySelectorAll('.menu-btn').forEach(function (botao) {
        botao.classList.toggle('ativo', botao.dataset.tela === nome)
    })

    mostrarMensagem('')

    if (nome === 'inicio') carregarPainel()
    if (nome === 'clientes') carregarClientes()
    if (nome === 'produtos') carregarProdutos()
    if (nome === 'pedidos') carregarTelaPedidos()
    if (nome === 'auditoria') carregarAuditoria()
}

document.querySelectorAll('.menu-btn').forEach(function (botao) {
    botao.addEventListener('click', function () {
        abrirTela(botao.dataset.tela)
    })
})

document.querySelectorAll('[data-ir]').forEach(function (botao) {
    botao.addEventListener('click', function () {
        abrirTela(botao.dataset.ir)
    })
})

document.getElementById('btnSair').addEventListener('click', encerrarSessao)

/* ---------- painel ---------- */

async function carregarPainel() {
    try {
        const painel = await requisicao('/api/painel')

        document.getElementById('indTotalClientes').textContent = painel.total_clientes
        document.getElementById('indProdutosEstoque').textContent = painel.produtos_em_estoque
        document.getElementById('indFaturamento').textContent = formatarMoeda(painel.faturamento_mes)
    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
}

/* ---------- clientes ---------- */

async function carregarClientes(pagina = estado.clientes.pagina) {
    try {
        const resposta = await buscarPagina('/api/clientes', pagina)
        const lista = document.getElementById('listaClientes')

        estado.clientes.pagina = resposta.pagina
        estado.clientes.dados = resposta.dados

        lista.innerHTML = resposta.dados.map(function (cliente) {
            return `
                <tr>
                    <td>${escapar(cliente.nome)}</td>
                    <td>${escapar(cliente.email)}</td>
                    <td>${escapar(cliente.telefone)}</td>
                    <td>${escapar(cliente.cpf_cnpj)}</td>
                    <td>
                        <button class="btn-editar" data-editar-cliente="${cliente.id_cliente}">Editar</button>
                        ${ehAdmin ? `<button class="btn-excluir" data-excluir-cliente="${cliente.id_cliente}">Excluir</button>` : ''}
                    </td>
                </tr>
            `
        }).join('') || '<tr><td colspan="5">Nenhum cliente cadastrado.</td></tr>'

        montarPaginacao('paginacaoClientes', resposta, carregarClientes)

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
}

function limparFormCliente() {
    document.getElementById('formCliente').reset()
    document.getElementById('idCliente').value = ''
}

document.getElementById('formCliente').addEventListener('submit', async function (event) {
    event.preventDefault()

    const id = document.getElementById('idCliente').value

    const dados = {
        nome: document.getElementById('clienteNome').value.trim(),
        email: document.getElementById('clienteEmail').value.trim(),
        telefone: document.getElementById('clienteTelefone').value.trim(),
        // A API aceita só dígitos; tiramos pontos, traços e barras digitados por costume.
        cpf_cnpj: document.getElementById('clienteDocumento').value.replace(/\D/g, '')
    }

    if (dados.cpf_cnpj.length !== 11 && dados.cpf_cnpj.length !== 14) {
        mostrarMensagem('O CPF deve ter 11 dígitos e o CNPJ 14 dígitos', 'erro')
        return
    }

    try {
        if (id) {
            await requisicao(`/api/clientes/${id}`, 'PUT', dados)
            mostrarMensagem('Cliente atualizado com sucesso', 'sucesso')
        } else {
            await requisicao('/api/clientes', 'POST', dados)
            mostrarMensagem('Cliente cadastrado com sucesso', 'sucesso')
        }

        limparFormCliente()
        carregarClientes()

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
})

document.getElementById('listaClientes').addEventListener('click', async function (event) {
    const idEditar = event.target.dataset.editarCliente
    const idExcluir = event.target.dataset.excluirCliente

    if (idEditar) {
        const cliente = estado.clientes.dados.find(function (item) {
            return item.id_cliente === Number(idEditar)
        })

        if (!cliente) return

        document.getElementById('idCliente').value = cliente.id_cliente
        document.getElementById('clienteNome').value = cliente.nome
        document.getElementById('clienteEmail').value = cliente.email || ''
        document.getElementById('clienteTelefone').value = cliente.telefone || ''
        document.getElementById('clienteDocumento').value = cliente.cpf_cnpj || ''
        document.getElementById('clienteNome').focus()

        mostrarMensagem(`Editando o cliente ${cliente.nome}`)
    }

    if (idExcluir) {
        if (!confirm('Excluir este cliente também apaga todos os pedidos dele. Deseja continuar?')) return

        try {
            const resultado = await requisicao(`/api/clientes/${idExcluir}`, 'DELETE')

            mostrarMensagem(
                `Cliente excluído com sucesso (${resultado.pedidos_removidos} pedido(s) removido(s))`,
                'sucesso'
            )
            limparFormCliente()
            carregarClientes()
        } catch (erro) {
            mostrarMensagem(erro.message, 'erro')
        }
    }
})

document.getElementById('limparCliente').addEventListener('click', function () {
    limparFormCliente()
    mostrarMensagem('')
})

/* ---------- produtos ---------- */

async function carregarProdutos(pagina = estado.produtos.pagina) {
    try {
        const resposta = await buscarPagina('/api/produtos', pagina)
        const lista = document.getElementById('listaProdutos')

        estado.produtos.pagina = resposta.pagina
        estado.produtos.dados = resposta.dados

        lista.innerHTML = resposta.dados.map(function (produto) {
            return `
                <tr>
                    <td>${escapar(produto.nome)}</td>
                    <td>${escapar(produto.descricao)}</td>
                    <td>${formatarMoeda(produto.preco)}</td>
                    <td class="${produto.estoque < 0 ? 'estoque-negativo' : ''}">${escapar(produto.estoque)}</td>
                    <td>
                        <button class="btn-editar" data-editar-produto="${produto.id_produto}">Editar</button>
                        ${ehAdmin ? `<button class="btn-excluir" data-excluir-produto="${produto.id_produto}">Desativar</button>` : ''}
                    </td>
                </tr>
            `
        }).join('') || '<tr><td colspan="5">Nenhum produto ativo.</td></tr>'

        montarPaginacao('paginacaoProdutos', resposta, carregarProdutos)

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
}

function limparFormProduto() {
    document.getElementById('formProduto').reset()
    document.getElementById('idProduto').value = ''
}

document.getElementById('formProduto').addEventListener('submit', async function (event) {
    event.preventDefault()

    const id = document.getElementById('idProduto').value

    const dados = {
        nome: document.getElementById('produtoNome').value.trim(),
        descricao: document.getElementById('produtoDescricao').value.trim(),
        preco: Number(document.getElementById('produtoPreco').value),
        estoque: Number(document.getElementById('produtoEstoque').value)
    }

    try {
        if (id) {
            await requisicao(`/api/produtos/${id}`, 'PUT', dados)
            mostrarMensagem('Produto atualizado com sucesso', 'sucesso')
        } else {
            await requisicao('/api/produtos', 'POST', dados)
            mostrarMensagem('Produto cadastrado com sucesso', 'sucesso')
        }

        limparFormProduto()
        carregarProdutos()

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
})

document.getElementById('listaProdutos').addEventListener('click', async function (event) {
    const idEditar = event.target.dataset.editarProduto
    const idExcluir = event.target.dataset.excluirProduto

    if (idEditar) {
        const produto = estado.produtos.dados.find(function (item) {
            return item.id_produto === Number(idEditar)
        })

        if (!produto) return

        document.getElementById('idProduto').value = produto.id_produto
        document.getElementById('produtoNome').value = produto.nome
        document.getElementById('produtoDescricao').value = produto.descricao || ''
        document.getElementById('produtoPreco').value = produto.preco
        document.getElementById('produtoEstoque').value = produto.estoque
        document.getElementById('produtoNome').focus()

        mostrarMensagem(`Editando o produto ${produto.nome}`)
    }

    if (idExcluir) {
        if (!confirm('Deseja realmente desativar este produto? Ele deixa de aparecer na lista e em novos pedidos.')) return

        try {
            await requisicao(`/api/produtos/${idExcluir}`, 'DELETE')

            mostrarMensagem('Produto desativado com sucesso', 'sucesso')
            limparFormProduto()
            carregarProdutos()
        } catch (erro) {
            mostrarMensagem(erro.message, 'erro')
        }
    }
})

document.getElementById('limparProduto').addEventListener('click', function () {
    limparFormProduto()
    mostrarMensagem('')
})

/* ---------- pedidos ---------- */

async function carregarDadosPedido() {
    try {
        const [clientes, produtos] = await Promise.all([
            buscarTodos('/api/clientes'),
            buscarTodos('/api/produtos')
        ])

        produtosDisponiveis = produtos

        const campoCliente = document.getElementById('pedidoCliente')
        const campoProduto = document.getElementById('pedidoProduto')
        const clienteEscolhido = campoCliente.value

        campoCliente.innerHTML = '<option value="">Selecione um cliente</option>' +
            clientes.map(function (cliente) {
                return `<option value="${cliente.id_cliente}">${escapar(cliente.nome)}</option>`
            }).join('')

        campoProduto.innerHTML = '<option value="">Selecione um produto</option>' +
            produtos.map(function (produto) {
                return `
                    <option value="${produto.id_produto}">
                        ${escapar(produto.nome)} - ${formatarMoeda(produto.preco)} - Estoque: ${produto.estoque}
                    </option>
                `
            }).join('')

        campoCliente.value = clienteEscolhido

        // Remove do pedido em montagem algum produto que tenha sido desativado nesse meio-tempo.
        for (let i = itensPedido.length - 1; i >= 0; i--) {
            if (!produtos.some(function (p) { return p.id_produto === itensPedido[i].id_produto })) {
                itensPedido.splice(i, 1)
            }
        }
        atualizarItensPedido()

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
}

function totalItensPedido() {
    return itensPedido.reduce(function (soma, item) {
        return soma + Number(item.preco) * item.quantidade
    }, 0)
}

function atualizarItensPedido() {
    const lista = document.getElementById('itensSelecionados')
    const total = document.getElementById('totalPedido')

    lista.innerHTML = itensPedido.map(function (item, indice) {
        const semSaldo = item.quantidade > item.estoque
        return `
            <li>
                ${escapar(item.nome)} - ${item.quantidade} x ${formatarMoeda(item.preco)}
                = ${formatarMoeda(Number(item.preco) * item.quantidade)}
                ${semSaldo ? '<span class="aviso">(estoque ficará negativo)</span>' : ''}
                <button type="button" data-remover-item="${indice}">Remover</button>
            </li>
        `
    }).join('')

    if (itensPedido.length === 0) {
        total.textContent = ''
        return
    }

    const valor = totalItensPedido()
    total.textContent = `Total estimado: ${formatarMoeda(valor)}` +
        (valor < VALOR_MINIMO_PEDIDO ? ` (mínimo de ${formatarMoeda(VALOR_MINIMO_PEDIDO)})` : '')
}

document.getElementById('adicionarItem').addEventListener('click', function () {
    const idProduto = Number(document.getElementById('pedidoProduto').value)
    const quantidade = Number(document.getElementById('pedidoQuantidade').value)

    if (!idProduto || !Number.isInteger(quantidade) || quantidade <= 0) {
        mostrarMensagem('Selecione um produto e informe uma quantidade inteira maior que zero', 'erro')
        return
    }

    const produto = produtosDisponiveis.find(function (item) {
        return item.id_produto === idProduto
    })

    if (!produto) {
        mostrarMensagem('Produto não encontrado', 'erro')
        return
    }

    // Um produto entra uma única vez por pedido (a API devolve 409 se vier repetido).
    if (itensPedido.some(function (item) { return item.id_produto === idProduto })) {
        mostrarMensagem('Este produto já está no pedido. Remova-o para informar outra quantidade.', 'erro')
        return
    }

    itensPedido.push({
        id_produto: produto.id_produto,
        nome: produto.nome,
        preco: produto.preco,
        estoque: produto.estoque,
        quantidade
    })

    document.getElementById('pedidoProduto').value = ''
    document.getElementById('pedidoQuantidade').value = 1

    atualizarItensPedido()

    // RN05: falta de saldo não impede o pedido, mas avisamos quem está vendendo.
    mostrarMensagem(
        quantidade > produto.estoque
            ? `Produto adicionado. Atenção: o estoque de ${produto.nome} ficará negativo.`
            : 'Produto adicionado ao pedido'
    )
})

document.getElementById('itensSelecionados').addEventListener('click', function (event) {
    const indice = event.target.dataset.removerItem

    if (indice === undefined) return

    itensPedido.splice(Number(indice), 1)
    atualizarItensPedido()
})

document.getElementById('formPedido').addEventListener('submit', async function (event) {
    event.preventDefault()

    const idCliente = document.getElementById('pedidoCliente').value

    if (!idCliente || itensPedido.length === 0) {
        mostrarMensagem('Selecione um cliente e adicione pelo menos um produto', 'erro')
        return
    }

    if (totalItensPedido() < VALOR_MINIMO_PEDIDO) {
        mostrarMensagem(`O valor total mínimo do pedido é ${formatarMoeda(VALOR_MINIMO_PEDIDO)}`, 'erro')
        return
    }

    const dados = {
        id_cliente: Number(idCliente),
        itens: itensPedido.map(function (item) {
            return {
                id_produto: item.id_produto,
                quantidade: item.quantidade
            }
        })
    }

    try {
        const resultado = await requisicao('/api/pedidos', 'POST', dados)

        mostrarMensagem(
            `Pedido ${resultado.id_pedido} registrado como rascunho. Total: ${formatarMoeda(resultado.valor_total)}`,
            'sucesso'
        )

        itensPedido.length = 0
        this.reset()

        await carregarTelaPedidos(1)

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
})

async function carregarTelaPedidos(pagina) {
    await carregarDadosPedido()
    await carregarPedidos(pagina)
}

async function carregarPedidos(pagina = estado.pedidos.pagina) {
    try {
        const resposta = await buscarPagina('/api/pedidos', pagina)
        const lista = document.getElementById('listaPedidos')

        estado.pedidos.pagina = resposta.pagina

        lista.innerHTML = resposta.dados.map(function (pedido) {
            const proxima = PROXIMA_ACAO[pedido.status]
            const podeCancelar = ehAdmin && STATUS_CANCELAVEIS.includes(pedido.status)

            return `
                <tr>
                    <td>${pedido.id_pedido}</td>
                    <td>${escapar(pedido.cliente)}</td>
                    <td>${escapar(pedido.usuario)}</td>
                    <td>${formatarData(pedido.data_pedido)}</td>
                    <td><span class="status status-${escapar(pedido.status)}">${escapar(pedido.status)}</span></td>
                    <td>${formatarMoeda(pedido.valor_total)}</td>
                    <td>
                        <button data-ver-pedido="${pedido.id_pedido}">Detalhes</button>
                        ${proxima ? `<button class="btn-avancar" data-avancar-pedido="${pedido.id_pedido}" data-novo-status="${proxima.status}">${proxima.rotulo}</button>` : ''}
                        ${podeCancelar ? `<button class="btn-excluir" data-cancelar-pedido="${pedido.id_pedido}">Cancelar</button>` : ''}
                    </td>
                </tr>
            `
        }).join('') || '<tr><td colspan="7">Nenhum pedido registrado.</td></tr>'

        montarPaginacao('paginacaoPedidos', resposta, carregarPedidos)

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
}

async function mostrarDetalhesPedido(id) {
    const resultado = await requisicao(`/api/pedidos/${id}`)
    const pedido = resultado.pedido
    const detalhes = document.getElementById('detalhesPedido')

    detalhes.innerHTML = `
        <h3>Pedido ${pedido.id_pedido}</h3>
        <p>Cliente: ${escapar(pedido.cliente)}</p>
        <p>Vendedor: ${escapar(pedido.usuario)}</p>
        <p>Data: ${formatarDataHora(pedido.data_pedido)}</p>
        <p>Status: <span class="status status-${escapar(pedido.status)}">${escapar(pedido.status)}</span></p>
        <h4>Produtos</h4>
        <div class="tabela-container">
            <table>
                <thead>
                    <tr><th>Produto</th><th>Quantidade</th><th>Preço unitário</th><th>Subtotal</th></tr>
                </thead>
                <tbody>
                    ${resultado.itens.map(function (item) {
                        return `
                            <tr>
                                <td>${escapar(item.produto)}</td>
                                <td>${item.quantidade}</td>
                                <td>${formatarMoeda(item.preco_unitario)}</td>
                                <td>${formatarMoeda(item.subtotal)}</td>
                            </tr>
                        `
                    }).join('')}
                </tbody>
            </table>
        </div>
        <h3>Total: ${formatarMoeda(pedido.valor_total)}</h3>
    `

    detalhes.classList.remove('escondido')
    detalhes.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

document.getElementById('listaPedidos').addEventListener('click', async function (event) {
    const { verPedido, avancarPedido, novoStatus, cancelarPedido } = event.target.dataset

    try {
        if (verPedido) {
            await mostrarDetalhesPedido(verPedido)
        }

        if (avancarPedido) {
            await requisicao(`/api/pedidos/${avancarPedido}/status`, 'PUT', { status: novoStatus })

            mostrarMensagem(`Pedido ${avancarPedido} agora está como "${novoStatus}"`, 'sucesso')
            await carregarPedidos()
        }

        if (cancelarPedido) {
            if (!confirm('Deseja cancelar este pedido? Os produtos voltam para o estoque.')) return

            await requisicao(`/api/pedidos/${cancelarPedido}`, 'DELETE')

            mostrarMensagem('Pedido cancelado e estoque devolvido', 'sucesso')
            await carregarTelaPedidos()
        }

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
})

/* ---------- auditoria ---------- */

async function carregarAuditoria(pagina = estado.auditoria.pagina) {
    try {
        const resposta = await buscarPagina('/api/auditoria', pagina)
        const lista = document.getElementById('listaAuditoria')

        estado.auditoria.pagina = resposta.pagina

        lista.innerHTML = resposta.dados.map(function (registro) {
            return `
                <tr>
                    <td>${formatarDataHora(registro.data_hora)}</td>
                    <td>${escapar(registro.usuario)}</td>
                    <td>${escapar(registro.acao)}</td>
                    <td>${escapar(registro.detalhe)}</td>
                </tr>
            `
        }).join('') || '<tr><td colspan="4">Nenhuma operação registrada.</td></tr>'

        montarPaginacao('paginacaoAuditoria', resposta, carregarAuditoria)

    } catch (erro) {
        mostrarMensagem(erro.message, 'erro')
    }
}

/* ---------- início ---------- */

if (logado) {
    carregarPainel()
}
