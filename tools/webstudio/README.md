<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# WebStudio

Primeira ferramenta definitiva do JumpCode. Monta sites estáticos (HTML e CSS)
dentro de um Studio: a conversa fica à esquerda e o site aparece à direita,
parte por parte, enquanto o agente trabalha.

## Como funciona

O modelo local responde com no máximo cerca de 1.024 tokens por vez, então o
site é montado em passos pequenos, um por chamada:

| Ação | Argumentos | Efeito |
| --- | --- | --- |
| `write_styles` | `name`, `css` | Cria ou substitui um bloco de CSS em `styles.css`. |
| `write_section` | `page`, `section`, `html`, `title` | Cria ou substitui uma seção de uma página. |
| `remove_section` | `page`, `section` | Apaga uma seção. |
| `remove_page` | `page` | Apaga uma página (menos a inicial). |
| `read` | `page` (com `section` opcional), ou `name`; `cursor` na continuação | Devolve o mapa, HTML ou CSS. Respostas grandes incluem os argumentos `next` para continuar sem omissões. |

Os nomes de páginas e seções são simplificados para nomes de arquivo seguros
(`Cardápio` vira `cardapio`). A página `index` vira `index.html`; as outras,
`<nome>.html`.

## Arquivos na pasta do Studio

- `site.json`: o modelo do site (páginas, seções e blocos de estilo).
- `index.html` e `<página>.html`: páginas geradas a partir do modelo, com
  marcadores `<!-- studio:section id -->` em volta de cada seção.
- `styles.css`: os blocos de estilo, na ordem em que foram criados.

As gravações ficam dentro da pasta recebida em `context["studio_root"]`.
Sem essa pasta, a ferramenta recusa o pedido. As chamadas são serializadas
com `.studio.lock`. Antes de alterar arquivos, `.studio-transaction.json`
registra o estado anterior; `site.json` confirma a transação por último.
Falhas restauram os arquivos anteriores. Uma interrupção é recuperada na
próxima operação; se a recuperação falhar, o resultado permanece incerto.
A prévia mantém a última versão enquanto há uma transação em andamento.

Os efeitos ficam registrados no diário do agente, inclusive quando a pasta
já foi autorizada pelo host. Uma ferramenta desativada na conversa ou removida
globalmente não é oferecida novamente só porque a aba do Studio existe.

`Abrir no Navegador` cria `.studio-preview.html`, uma prévia isolada com CSP
e sandbox, sem scripts do conteúdo gerado, rede, formulários ou redirecionamentos
automáticos. CSS, SVG e links entre as páginas são preservados. Os arquivos
HTML originais continuam disponíveis como código-fonte; abri-los manualmente
fora do JumpCode não utiliza essa proteção.

Blocos de CSS podem ser substituídos integralmente independentemente da proporção
de tamanho. Use `read` com `name` para consultar o conteúdo antes da alteração.
HTML pode ser consultado por página ou por seção (`page` + `section`). O tamanho
da leitura é limitado em bytes do JSON serializado, incluindo escapes e Unicode.
Se houver `next`, repita `read` com esses argumentos; trechos parciais indicam
`offset` e `totalCharacters`. O cursor confere a versão do conteúdo para não
misturar alterações concorrentes. Não muda o contexto disponível do modelo.

As duas prévias resolvem links relativos e fragmentos apenas entre páginas do
snapshot. Destinos externos continuam bloqueados; nenhum link passa a conceder
acesso a arquivos, rede ou scripts. A inserção de CSS preserva seu texto literal.

## Limites

12 páginas, 40 seções por página, 30 blocos de estilo, 20.000 caracteres por
seção ou bloco e 1.000.000 de caracteres no total. Sem rede, sem scripts
externos e sem acesso aos arquivos do projeto.

## Testes

```powershell
python -B -m unittest discover -s tools/webstudio/tests -v
node tools/webstudio/tests/test-browser.cjs
```
