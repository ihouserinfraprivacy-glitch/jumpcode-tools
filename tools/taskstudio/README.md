<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# TaskStudio

Ferramenta definitiva do JumpCode que transforma um pedido em um plano de
tarefas ligadas e acompanha o trabalho dentro de um Studio: a conversa fica à
esquerda e o plano aparece à direita, como mapa, lista, quadro, linha do tempo,
raias ou metrô.

## Como funciona

O pacote não executa nenhuma tarefa. Ele guarda o plano em arquivos JSON na
pasta do Studio e registra o que o agente informa enquanto trabalha com as
outras ferramentas (arquivos e terminal do projeto). Nunca lê a pasta do
projeto, nunca usa a rede e nunca recebe o valor de uma chave ou senha: uma
condição do tipo `secret` guarda só o nome da variável que o usuário coloca no
`.env` do projeto.

O modelo local chama ações pequenas:

| Ação | Argumentos | Efeito |
| --- | --- | --- |
| `plan` | `title`, `request`, `tasks`, `draft` | Cria o plano (versão 1). As tarefas são numeradas 1, 2, 3... na ordem da lista e `deps` usa esses números. |
| `read` | `id` opcional | Sem `id`: uma linha por tarefa, contagens, pendências e se há pasta de projeto. Com `id`: a tarefa inteira. |
| `start` / `progress` / `finish` | `id`, `note`, `percent`, `log`, `files`, `result`, `criteria` | Executa uma tarefa pronta, registra o andamento e conclui; `finish` diz o que ficou pronto. |
| `fail` / `need` / `resolve` / `skip` / `pause` | `id`, ... | Problema, condição que precisa do usuário, condição resolvida, "para depois" e pausa. |
| `edit` / `propose` | `id`, `text`, ... / `summary`, `changes`, `extra` | Recalibração: registra a mudança do usuário, pausa o que estava em execução e propõe uma mudança por tarefa afetada. |
| `apply` / `discard` | | Aplica a proposta (nova versão do plano, com histórico) ou descarta. Nada é refeito antes da aprovação. |
| `focus` | `id`, `mode`, `note` | Seleciona uma tarefa no Studio (`view.json`). |

O tipo de cada mudança (`refazer`, `ajustar`, `alterar`, `nova`, `remover`) é
calculado pelo estado da tarefa, nunca escolhido pelo modelo, e `apply` recusa
a proposta se alguma tarefa mudou de estado depois dela.

## Arquivos na pasta do Studio

A ferramenta grava apenas dentro de `context["studio_root"]`, sob o lock
`.taskstudio.lock`. O arquivo `state.json` contém todos os documentos abaixo,
substituídos em uma única operação atômica, inclusive na aplicação da proposta.
Cada documento tem uma `revision` crescente e limite de 2.000.000 bytes UTF-8;
o snapshot completo admite até 8.100.000 bytes.

- `plan.json`: o plano e o estado de cada tarefa.
- `proposal.json`: a recalibração esperando o usuário.
- `history.json`: as versões do plano (até 30) e o motivo de cada uma.
- `view.json`: o que o Studio deve mostrar e selecionar.

Instalações anteriores com os quatro arquivos separados são lidas normalmente
e migradas no próximo salvamento. Esses arquivos antigos permanecem no disco,
mas deixam de ser usados quando existe `state.json`. Snapshot inválido bloqueia
novas alterações; a interface mantém a última visão válida. Em documentos legados, o plano
danificado gera um aviso claro (e pode ser substituído com `plan`); proposta,
histórico e visão danificados são tratados como ausentes. Limites: 60 tarefas,
12 dependências, 6 condições e 20 critérios por tarefa, 40 linhas de log por
tarefa. O formato completo está em `CONTRACT.md`.

Sem `context["source_root"]` (Studio aberto pela tela inicial) só é possível
planejar; para executar, o usuário abre o TaskStudio a partir de um projeto.

O início do plano, `apply` e `resolve` exigem a confirmação do host para o
snapshot apresentado. Uma proposta alterada durante a aprovação não é aplicada.
As permissões de arquivos e terminal continuam independentes; uma recalibração
pendente bloqueia efeitos no projeto até ser aplicada ou descartada.
Dependências são somente as declaradas pelo modelo; `[]` remove dependências,
critérios ou condições. Critérios parcialmente cumpridos não concluem a tarefa.
A indicação de execução usa a identidade do pedido fornecida pela IDE; outro
pedido não reativa visualmente uma tarefa antiga.

## Testes

```powershell
$env:PYTHONPATH = "tools/taskstudio/src"
python -B -m unittest discover -s tools/taskstudio/tests -v
python tools/taskstudio/tests/make_fixtures.py
```

`tests/fixtures/barbearia` guarda um plano de exemplo (sistema de agendamento de
uma barbearia) com tarefas concluídas, em execução, com problema, esperando o
usuário e uma recalibração aplicada, para conferir a interface.
