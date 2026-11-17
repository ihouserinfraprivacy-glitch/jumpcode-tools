<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# CloudStudio

Ferramenta definitiva do JumpCode que liga uma nuvem AWS de mentira no
computador do usuário e mostra essa nuvem dentro de um Studio: a conversa fica à
esquerda e a nuvem aparece à direita, por serviço, como mapa, como as chamadas
que o app fez e como logs ao vivo.

## Como funciona

A nuvem local é um processo à parte (`python -m jumpcode_cloudstudio.engine`)
escrito só com a biblioteca padrão do Python, sem Docker e sem dependências. Ele
escuta em `http://127.0.0.1:4566` (ou na próxima porta livre até 4599) e fala o
protocolo da AWS: os SDKs e a CLI de sempre funcionam apontando
`AWS_ENDPOINT_URL` para esse endereço, com qualquer chave de acesso. O processo
vive enquanto o processo do agente viver: ele segura a outra ponta de um pipe e
para sozinho quando o pipe fecha.

Serviços emulados: S3, DynamoDB, SQS, SNS, Lambda, API Gateway (HTTP APIs),
Step Functions, EventBridge, EventBridge Scheduler, Secrets Manager, Parameter
Store, CloudWatch Logs e STS. Qualquer outro serviço responde com
`NotImplemented` e uma mensagem clara.

As funções Lambda rodam como processos locais com o Python ou o Node.js do
computador, a partir da pasta do projeto (lida a cada execução) ou de um zip.
Recebem `AWS_ENDPOINT_URL`, região, chaves de teste e `TZ=UTC`, como na AWS.

Chamadas do navegador precisam ter origem local. O servidor rejeita origens e
hosts externos; SDKs locais continuam usando chaves de teste. Integrações HTTP
do SNS e do API Gateway só alcançam loopback, inclusive após redirecionamentos,
e não usam o proxy do sistema. A execução de código Lambda é um processo local,
não uma sandbox do sistema operacional; continua sujeita à autorização da
ferramenta pelo host. A interface envia pedidos pelo chat, sem executar ações
diretamente nem contornar a aprovação.

Cancelar uma invocação encerra sua árvore de processos; cancelar uma execução
síncrona de Step Functions interrompe suas etapas e esperas. A nuvem permanece
ligada. Alterações já concluídas e trabalhos assíncronos independentes não são
desfeitos. Uma requisição já recebida por outro servidor local não pode ser
desfeita pelo CloudStudio.

Estado ou cópia persistida ilegível impede a abertura/limpeza, preservando os
dados. Fusos IANA que dependem de uma base não disponível no Python do Windows
retornam erro explícito; nunca são substituídos silenciosamente por UTC. A base
`tzdata` é opcional no ambiente Python; não é baixada automaticamente.

Enquanto roda, a nuvem escreve na pasta do Studio os arquivos que a interface lê
(`cloud.json`, `resources.json`, `calls.json`, `logs.json`). Valores de segredos
e de parâmetros `SecureString` nunca entram nesses arquivos nem nos resultados
que o modelo recebe.

## Ações do modelo

| Ação | Efeito |
| --- | --- |
| `status`, `start`, `stop` | Diz o que existe e os últimos erros; liga (memória ou persistente, região) e desliga. |
| `create`, `remove` | Cria ou remove um recurso em termos simples: `bucket`, `table`, `queue`, `topic`, `function`, `api`, `secret`, `parameter`, `schedule`, `rule`, `statemachine`. |
| `invoke`, `request`, `send`, `run` | Executa uma função, chama uma rota da API, envia uma mensagem, executa uma máquina de estados. |
| `calls`, `logs` | As chamadas recentes (com os erros) e os logs das funções. |
| `env` | Escreve o endereço e as chaves de teste no `.env.local` do projeto. |
| `snapshot`, `restore`, `reset` | Cópias do estado, voltar para uma cópia, esvaziar a nuvem. |
| `focus` | Mostra uma visão ou um recurso no Studio. |

O contrato completo está em [CONTRACT.md](CONTRACT.md).

Recursos com o mesmo nome são identificados por serviço, conta e região.
As ações de recurso aceitam `account` e `region`; a interface preserva esses
dados no pedido ao agente. Rascunhos de formulários também são separados por
essa identidade. Mapas DynamoDB usam uma representação marcada (`$map`) para
não confundir nomes de atributos com os tipos numérico, binário ou conjunto.

## Desenvolvimento

- Testes: `python -B -m unittest discover -s tests` nesta pasta. Os testes que
  usam o SDK da AWS ficam de fora quando o `boto3` não está instalado; aponte
  `CLOUDSTUDIO_TEST_SDK` para uma pasta com o `boto3` para rodá-los.
- Interface: `ui-dev/scenario.py` roda o backend de exemplo da Barbearia do Zé
  numa nuvem local de verdade e guarda os arquivos do Studio em
  `ui-dev/fixtures/barbearia`; `node ui-dev/shoot.mjs` captura todas as telas
  com a mesma política de segurança do JumpCode. `assets/cover.png` e
  `assets/mark.svg` são a capa e a marca desenhadas (a nuvem laranja); `node
  ui-dev/cover.mjs` troca a capa por uma captura do Studio.
- Regressões da interface: `node tools/cloudstudio/ui-dev/regressions.mjs`,
  a partir da raiz do repositório, com Playwright já instalado. O teste usa um
  host simulado local: verifica os pedidos, sem executar ações do agente.
