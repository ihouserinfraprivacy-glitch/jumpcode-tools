<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# Pacotes de ferramenta do JumpCode

Uma ferramenta pode ser criada, publicada, instalada e atualizada sem entrar no
código do JumpCode e sem reconstruir o aplicativo. Ela viaja como um pacote
`.jctool`; o JumpCode instala o pacote na pasta do perfil e a executa em um
processo próprio. As ferramentas oficiais são mantidas em
https://github.com/ihouserinfraprivacy-glitch/jumpcode-tools e baixadas por GitHub Releases.
O agente carrega somente pacotes instalados.

## O que é um pacote

Um ZIP cuja primeira entrada é `jumpcode-tool.json`, seguido exatamente dos
arquivos que o manifesto lista. O contrato inteiro (campos, limites e regras)
está em um único arquivo, usado pelo aplicativo, pelas ferramentas de
empacotamento e pelo backend:
`contract/tool-package.ts` (cópia do contrato do host).

O manifesto declara:

- formato do pacote (`format: 1`), identidade (`id`), publicador e versão;
- contrato de execução (`contract: 1`) e compatibilidade (versão mínima do
  JumpCode, faixa de Python do executor, plataformas);
- módulo de entrada (`entry`), isolamento pedido (`container` ou `process`) e
  capacidades (`suppliedText`, `projectFiles`, `network`);
- a entrada do catálogo (`tool`): textos, instruções para o modelo e esquema
  dos argumentos, tudo estático;
- metadados opcionais da loja (`store`): `categories`, com pares `id`/`name`,
  e `license`. A publicação passa a aparecer no catálogo sem cadastrar um ID
  no aplicativo; sem categorias declaradas, usa a categoria Ferramentas;
- a interface do Studio (`studio.ui`), as imagens (`assets`) e o formato dos
  dados que grava e que consegue abrir (`studio.data`);
- dependências (`dependencies`) e o inventário (`files`) com tamanho e SHA-256
  de cada arquivo.

Regras que valem sempre:

- Ler o manifesto ou a lista de ferramentas nunca importa nem executa código do
  pacote. Não existe script de instalação: campos desconhecidos são recusados.
- Identidade: nomes simples (`webstudio`) pertencem ao publicador oficial.
  Qualquer outro publicador usa `<publicador>--<nome>`. Um pacote importado do
  computador sem confiança estabelecida é instalado como `local--<id>` e nunca
  ocupa o lugar de uma ferramenta oficial.
- Dependências: o tipo aceito hoje é `python-vendored` (código de terceiros
  dentro do pacote, com origem e hash do artefato original, carregado só pelo
  processo daquela ferramenta). Nada é instalado no Python do agente. Um tipo
  que esta versão não conhece torna o pacote incompatível; o formato evolui
  acrescentando tipos, não por exceções.
- Limites do formato 1 (declarados em `jumpCodeToolPackageLimits`): manifesto
  de 1 MiB, pacote de 128 MiB, arquivo de 64 MiB, 2000 arquivos, caminho de 160
  caracteres, marca de 16 KiB e capa de 300 KiB. Conteúdo maior pede outro
  formato, não uma exceção.

## Criar e empacotar

Estrutura mínima da ferramenta (igual à das oficiais em `tools/<id>/`):

```
minha-ferramenta/
  jumpcode-tool.source.json     descritor: o manifesto sem a lista de arquivos
  src/minha_ferramenta/
    __init__.py                 exporta validate(arguments) e run(arguments, context)
    tool.json                   textos, instruções e esquema dos argumentos
    ui/app.js, ui/app.css       interface própria do Studio (opcional)
    assets/mark.svg, cover.png  imagens (opcional)
```

O descritor diz quais pastas entram no pacote (`include`) e pode apontar o
`tool.json` (`"tool": "src/.../tool.json"`). `run` pode aceitar `cancelled` e
`approve`; `check_effect(context)` é opcional. Dentro do contêiner, uma
ferramenta que declarou `projectFiles` não abre a pasta do projeto: recebe em
`context["source"]` um objeto com `list(path)` e `read(path)`, atendido pelo
JumpCode dentro da pasta autorizada da conversa.

```
node build/jumpcode-tools/cli.ts pack tools/webstudio --out webstudio-1.0.1.jctool
node build/jumpcode-tools/cli.ts inspect webstudio-1.0.1.jctool
```

Empacotar só lê arquivos e calcula hashes. As mesmas fontes geram sempre os
mesmos bytes (entradas ordenadas, sem compressão, data e permissão fixas).

## Confiança e assinatura

Os documentos seguem o formato de metadados do TUF 1.0:

- `root`: diz quais chaves têm cada papel. Vai com o aplicativo
  (`jumpCodeToolsTrustRoot` na configuração do produto). Só muda por um root
  novo, da versão seguinte, assinado pelo root anterior e por si mesmo.
- `targets`: a lista de pacotes publicados, com identidade, versão, publicador,
  hash, tamanho, capacidades, isolamento e estado (`available`, `withdrawn`,
  `revoked`). É assinada fora do servidor.
- `snapshot` e `timestamp`: assinados pelo servidor, dizem qual lista é a atual
  e até quando. O servidor não consegue acrescentar um pacote, trocar um hash
  ou uma permissão, nem introduzir uma chave.

```
node build/jumpcode-tools/cli.ts keygen --out root.key.json        (três vezes: root, targets, servidor)
node build/jumpcode-tools/cli.ts root --version 1 --expires 2027-12-31T00:00:00Z \
     --root-key <hex> --targets-key <hex> --server-key <hex> --out root.unsigned.json
node build/jumpcode-tools/cli.ts sign --key root.key.json --in root.unsigned.json --out root.json
node build/jumpcode-tools/cli.ts sign --key targets.key.json --in targets.unsigned.json --out targets.json
```

A assinatura prova origem e integridade; não prova que o código é inofensivo.
Por isso a publicação exige também a revisão dos mesmos bytes (veja
`backend/jumpcode-api/TOOL_PACKAGES.md`).

Uma rotação preserva a maior versão de `targets` já aceita. Trocar a chave
de `targets`, `snapshot` ou `timestamp` não permite reapresentar uma lista
anterior nem alterar o conteúdo de uma versão já conhecida. Consultas
concorrentes são verificadas contra o estado mais recente ao gravar, para
uma resposta atrasada não desfazer uma revogação.

## Enviar para a loja

Enviar e importar são atos diferentes. Enviar não instala nada no computador e
não publica: cria um rascunho no backend.

1. A conta precisa ter sido habilitada como publicador pelo operador.
2. No JumpCode: lista de ferramentas → Importar → "Enviar para a Loja", ou o
   comando "JumpCode: Enviar Ferramenta para a Loja". O aplicativo confere o
   pacote, mostra o publicador e o hash e envia em blocos.
3. O backend valida a estrutura (sem executar nada), confere se a conta pode
   publicar aquele identificador e se a versão está livre.
4. O operador revisa e aprova citando o hash; a lista é assinada fora do
   servidor e só então o pacote fica disponível.

Ao cancelar um envio, o aplicativo aguarda o identificador do rascunho e pede
sua exclusão com uma requisição independente do cancelamento. Se a limpeza
não for confirmada, avisa; o rascunho também continua sujeito à expiração do
backend. Cancelar não publica nem aprova o pacote.

## Instalar, atualizar e remover

- Loja → Atualizações mostra as ferramentas com versão empacotada mais nova e o
  botão "Atualizar". "Verificar Atualizações" consulta a lista assinada.
- Antes de qualquer código ficar disponível, o aplicativo confere a lista
  assinada, o hash e o tamanho do pacote, o manifesto e cada arquivo; extrai em
  área temporária e ativa com uma única troca de pasta. Download cancelado,
  parado ou sem espaço não deixa nada instalado.
- A versão anterior fica guardada. Uma conversa em andamento termina com a
  versão com que começou; a nova vale a partir do turno seguinte. O agente não
  é reiniciado.
- Dados do Studio: o pacote declara o formato que grava e os que abre. Uma
  versão que não abre o que um Studio já guarda não é ativada, e voltar à
  versão anterior é recusado quando ela não abriria os dados atuais. Antes de
  uma mudança de formato é feita uma cópia em `.jumpcode-tool-backups/`.
- Remover apaga o pacote do computador. Conversas, escolhas por conversa e os
  resultados dos Studios ficam.
- O que está instalado é estado local do computador; a biblioteca da conta é
  outra coisa e continua como estava.
- Instalar ou ativar não dá acesso a nada: cada chamada segue as regras de
  aprovação da conversa, como antes.
- Atualizar pede nova confirmação se acrescentar uma capacidade declarada ou
  passar de contêiner para processo comum. A confirmação vale para o hash
  mostrado; se a oferta mudar, a instalação é recusada. Cancelar mantém a
  versão instalada. Atualizações sem ampliação de acesso não ganham outro
  diálogo por essa regra.

## Importar do PC

Lista de ferramentas → Importar → "Importar do PC" (ou o comando "JumpCode:
Importar Ferramenta do Computador"). O aplicativo confere o pacote e mostra,
antes de instalar:

- se os bytes são os que a JumpCode publicou, os de outro publicador da loja ou
  um pacote sem origem confirmada;
- como ele roda e o que pediu;
- o SHA-256.

Só então pede a concordância para instalar e permitir a execução. Nada é
enviado para a loja nem para a conta. O que é instalado é uma cópia com o hash
mostrado: alterar a pasta ou o arquivo de origem não muda o que está
instalado. Para atualizar, importe de novo.

## Como uma ferramenta roda

O agente nunca importa um pacote instalado. Cada ferramenta roda em um processo
iniciado sob demanda, com ambiente novo (sem tokens, chaves ou variáveis do
JumpCode) e sem os módulos do agente.

A aprovação é verificada antes de iniciar/importar código instalado, inclusive
para `check_effect`. Essa consulta e a inicialização respeitam Stop e o prazo
do turno. Processos com rede ou sem contêiner são encerrados ao terminar a
operação autorizada; não ficam ociosos com os acessos da operação anterior.
Código em processo comum nunca é tratado como uma operação segura de texto
apenas pela declaração de capacidades.

| Situação | Como roda |
| --- | --- |
| Pacote sem a confiança do publicador oficial (importado ou de outro publicador) | Sempre dentro de um AppContainer do Windows |
| Pacote oficial que pede `container` | Dentro de um AppContainer do Windows |
| Pacote oficial cuja entrada assinada pede `process` | Processo comum, com os privilégios da pessoa |

O que o AppContainer garante, medido com Python real: sem leitura ou escrita
fora da pasta do Studio (pasta do usuário, Documentos, `.ssh`, projeto), sem
rede (inclusive para o próprio computador) a menos que o pacote tenha declarado
`network`, sem acesso a outros processos; processos filhos herdam o contêiner.
Cada ferramenta e cada Studio têm o próprio contêiner. Se o contêiner não puder
ser criado, a ferramenta não roda: não existe execução sem isolamento como
alternativa.

Limites reais do AppContainer:

- continuam legíveis as pastas que o Windows abre a todo aplicativo empacotado
  (Windows, Arquivos de Programas) e partes do registro, inclusive as variáveis
  de ambiente do usuário (`HKCU\Environment`);
- CPU, memória e disco não são limitados;
- isolamento efetivo existe hoje só no Windows; em outros sistemas pacotes sem
  confiança oficial não rodam.

Processo comum não é isolamento. O que protege a pessoa nesse caso é a
assinatura e a revisão daqueles bytes; por isso só o publicador oficial pode
pedi-lo.

A interface do Studio continua em uma webview sem rede e sem acesso a arquivos.
A de uma ferramenta sem confiança oficial não envia mensagens em nome da pessoa
(preenche a caixa e a pessoa decide) e só recebe arquivos do projeto se o
pacote declarou `projectFiles`.

Para ferramentas instaladas, ler ou abrir um arquivo do projeto pela interface
do Studio exige confirmação para aquele arquivo. Depois da confirmação, o
JumpCode verifica novamente a versão/bloqueio da ferramenta, a pasta do projeto
e o caminho real; uma mudança enquanto o diálogo estava aberto invalida a
operação. Declarar `projectFiles` não concede essa autorização.

## Retirada, revogação e falta de rede

- Retirada (`withdrawn`): a versão deixa de ser oferecida; quem já tem continua
  usando.
- Revogação (`revoked`): a versão não inicia novas execuções, processos já
  iniciados são encerrados (a chamada em curso termina como resultado incerto)
  e o motivo aparece na lista de ferramentas e em Atualizações. O aplicativo
  não troca sozinho para outra versão; oferece "Atualizar" ou "Voltar à Versão"
  quando a outra versão pode rodar.
- Falha ao consultar o backend não é revogação: nada muda no que está
  instalado.
- Limite: sem rede, uma revogação nova não é conhecida. A lista em uso tem data
  de validade; passada a data, o aplicativo não instala nada novo, mas as
  ferramentas já instaladas e verificadas continuam funcionando.

## Migração das ferramentas oficiais

As oito ferramentas oficiais têm `jumpcode-tool.source.json` e empacotam.
WebStudio e TaskStudio rodam no contêiner; ArchStudio, CloudStudio, PayStudio,
SheetStudio, 3D Generator e AppStudio rodam como processo comum porque leem e
gravam a pasta do projeto diretamente.

As fontes e testes das ferramentas ficam no repositório jumpcode-tools.
O JumpCode não embute suas implementações. Catálogo e confiança permanecem na VPS;
os arquivos vêm das Releases e são conferidos pelo instalador. IDs, escolhas das
conversas, aprovações e dados dos Studios permanecem. Um Studio sem pacote instalado
mostra uma ação para instalar pelo fluxo normal, sem criar nem apagar conversas.
Desinstalar não apaga seus arquivos. A instalação não concede permissões de execução.

O contexto `source_root` continua indicando o projeto vinculado pelo host. Saber o
caminho não permite abri-lo: no contêiner, o acesso permanece negado pelo Windows e
leituras pelo broker exigem `projectFiles`. Isso preserva Studios que só precisam
saber se existe um projeto, sem dar acesso aos seus arquivos.

## Garantias locais de instalação e atualização

A confirmação de importação vale para o SHA-256, a identidade instalada, a
origem verificada e o isolamento mostrados. A descrição e o hash vêm da mesma
cópia privada do arquivo. Se os bytes ou essa classificação mudarem antes da
ativação, a operação é recusada e exige nova conferência e confirmação.

Um manifesto instalado ausente, alterado ou inválido deixa aquela instalação
visível e bloqueada. Não há retorno automático à ferramenta embutida. A pessoa
pode restaurar a versão anterior íntegra ou remover a instalação e importar
novamente; os dados dos Studios são preservados pela desinstalação.

No Windows, cada turno mantém abertos os manifestos das versões selecionadas,
inclusive antes de iniciar um processo e entre chamadas. O coletor não consegue
mover essas pastas para descarte enquanto houver esse uso. A liberação ocorre
com o fim da referência do turno ou fechamento do agente, sem prazo fixo de
retenção. Processos em execução continuam com sua proteção própria.

As capacidades vêm do manifesto mesmo quando `tool.details` não existe. Isso
preserva a declaração de acesso no catálogo e no Studio. Ler arquivos continua
exigindo consentimento; pacotes em processo comum, com rede ou com acesso ao
projeto mantêm as aprovações correspondentes.
