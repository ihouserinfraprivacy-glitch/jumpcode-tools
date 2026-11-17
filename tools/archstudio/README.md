<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# ArchStudio

Ferramenta definitiva do JumpCode que desenha a arquitetura de qualquer
software (backend, site, aplicativo, firmware) dentro de um Studio: a conversa
fica à esquerda e o mapa aparece à direita.

O mapa tem três níveis encaixados: **sistemas** → **serviços** → **arquivos**,
mais os bancos de dados, filas e serviços externos, e as ligações entre tudo
(chamadas HTTP e gRPC, mensagens, acesso a dados, imports). Também mostra onde
cada parte roda (Docker Compose, Kubernetes, Terraform, Vercel...), fluxos passo
a passo e propostas de mudança desenhadas sobre o mapa atual.

## Como funciona

A análise é determinística e local: lê os arquivos da pasta do projeto, nunca
executa código, nunca usa a rede e nunca segue links simbólicos ou junções para
fora da pasta. O modelo local (que responde com cerca de 1.000 tokens por vez)
só chama ações pequenas:

| Ação | Argumentos | Efeito |
| --- | --- | --- |
| `scan` | | Analisa a pasta do projeto e grava o mapa. |
| `read` | `id` opcional | Sem `id`: resumo do mapa (até ~3.000 caracteres). Com `id`: detalhes de uma parte ou ligação. |
| `focus` | `id`, `ids`, `note`, `mode` | Seleciona e destaca no Studio (`view.json`). |
| `write_part` | `id`, `level`, `name`, `kind`, `parent`, `tech`, `summary` | Cria ou altera uma parte à mão. |
| `write_link` | `from`, `to`, `protocol`, `label`, `async` | Cria uma ligação à mão. |
| `remove` | `id` | Apaga uma parte (com o que está dentro) ou uma ligação. |
| `write_path` / `remove_path` | `name`, `steps` / `id` ou `name` | Fluxos passo a passo (até 12, com até 24 passos). |
| `write_proposal` / `clear_proposal` | `title`, `summary`, `nodes`, `links` | Proposta de mudança mostrada como "Atual / Proposta". |

Partes e ligações escritas pelo modelo ficam marcadas com `manual: true` e são
mantidas quando o mesmo projeto é analisado de novo, incluindo mover um serviço
para outro sistema e escolher se uma conexão é síncrona ou assíncrona. As
evidências e contagens encontradas no código continuam sendo atualizadas.
A origem é identificada pelo caminho normalizado, não pelo
nome da pasta. Trocar a origem não transfere edições, fluxos ou propostas de outro
projeto. Mapas antigos sem identidade de origem não são mesclados automaticamente;
uma cópia local do mapa substituído fica em `.archstudio-previous-model`.

## O que a análise encontra

- **Sistemas**: pastas com manifesto de projeto (`package.json`, `pubspec.yaml`,
  `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, `build.gradle`, `*.csproj`,
  `Package.swift`, `platformio.ini`, ESP-IDF, `composer.json`, `Gemfile`,
  `mix.exs`...), com o tipo (backend, web, mobile, embarcado, desktop,
  biblioteca) e a tecnologia.
- **Serviços**: subprojetos, pastas como `services/*`, `servicos/*`, `apps/*`,
  `cmd/*`, ou as pastas de `src/` e `lib/`. Em aplicativos, cada serviço ganha
  um papel (telas, estado, repositórios, fontes); em firmware, cada módulo C
  vira um serviço (tarefas, módulos, drivers) e o hardware é deduzido dos
  drivers (GPS, modem, sensores...).
- **Arquivos** e **imports** entre arquivos (JS/TS, Python, Go, Dart, C/C++,
  Java/Kotlin, Rust, C#, Ruby, PHP).
- **Comunicação**: URLs e variáveis de ambiente que apontam para outros
  serviços, rotas declaradas, gRPC (`.proto` e clientes gerados), tópicos e
  filas (RabbitMQ, Kafka, NATS, MQTT, Redis), filas do FreeRTOS, bancos de dados,
  serviços externos conhecidos e aplicativos que chamam o gateway do backend.
- **Implantação**: Docker Compose, Kubernetes, Terraform, Dockerfile,
  `vercel.json`, `fly.toml`, `serverless.yml` e `Procfile`.

Pastas de dependências, build, testes, documentação e exemplos ficam de fora,
assim como as pastas listadas de forma simples no `.gitignore` da raiz.

Limites: 20.000 arquivos listados, 256 KB lidos por arquivo, 64 MB no total e
cerca de 90 segundos; depois disso o mapa é concluído com o que foi encontrado e
o resumo avisa. Cada serviço mostra até 5.000 arquivos (os maiores).

## Arquivos na pasta do Studio

A ferramenta grava apenas dentro de `context["studio_root"]`, sempre de forma
atômica (arquivo temporário e troca, com novas tentativas no Windows):

- `model.json`: a arquitetura (veja `CONTRACT.md`).
- `model-partial.json`: prévia da análise em andamento; não substitui o mapa salvo.
- `progress.json`: andamento da análise, atualizado a cada ~0,3 s.
- `view.json`: o que o Studio deve selecionar e destacar.
- `paths.json`: fluxos passo a passo.
- `proposal.json`: a proposta de mudança.

A pasta a analisar chega em `context["source_root"]`. Sem ela, `scan` pede
para o usuário abrir um projeto ou escolher uma pasta no Studio; o modelo ainda
pode desenhar um sistema descrito em texto. Se o usuário interromper a análise,
o mapa anterior é mantido e `progress.json` registra "Interrompido".
Um encerramento abrupto também preserva `model.json`: somente a análise concluída
é gravada nele. A próxima ação descarta a prévia incompleta sob o lock do Studio.
Prévia e progresso carregam o identificador da execução emitido pelo host. A
interface só os apresenta como ativos enquanto o recibo correspondente estiver
em execução nesta conversa; um novo pedido não reativa uma análise interrompida.
Reabrir o Studio durante uma análise ativa mantém a prévia disponível. Essa
correlação não altera permissões nem faz consultas periódicas adicionais.
Cada arquivo admite até 48.000.000 bytes UTF-8; a interface recebe até 104.000.000
bytes por snapshot (mapa salvo, prévia e metadados). Falhas de leitura/transporte
mostram um aviso e preservam o último mapa exibido, em vez de mostrar um mapa vazio.
O código exibido é renovado na reanálise e na troca de origem, sem releituras por
atualizações de progresso.

## Testes

```powershell
python -B -m unittest discover -s tools/archstudio/tests -v
node tools/archstudio/tests/test-browser.cjs
```

O projeto de exemplo `tests/fixtures/rota-certa` é uma plataforma de entregas
(Go, Flutter, React Native, Next.js, firmware ESP32-S3, Python, Compose,
Kubernetes e Terraform). `tests/fixtures/rota-certa-model.json` guarda o
resultado da análise para comparação com a interface.
