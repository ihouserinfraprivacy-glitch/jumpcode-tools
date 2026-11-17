# JumpCode Tools

Pacotes oficiais das ferramentas do JumpCode, distribuídos por [GitHub Releases](https://github.com/ihouserinfraprivacy-glitch/jumpcode-tools/releases).

O catálogo, os metadados assinados de confiança e as revogações continuam em https://api.jumpcode.codes. Instale pela loja do JumpCode atualizado: o aplicativo verifica assinatura, tamanho, SHA-256, manifesto e compatibilidade antes da instalação. As permissões de cada conversa e as aprovações de execução continuam valendo.

## Versão 1.0.1

WebStudio, ArchStudio, TaskStudio, CloudStudio, PayStudio, SheetStudio, 3D Generator e AppStudio. Os oito arquivos `.jctool` são idênticos aos publicados anteriormente na API. `SHA256SUMS` contém os hashes, e `root-1.json` / `targets-1.json` são os documentos públicos assinados da publicação. Consulte o serviço para obter o estado de confiança atual; uma release histórica não substitui verificações de revogação e validade.

Este repositório distribui os pacotes, sem exigir conta ou token do GitHub para download. Nenhuma chave privada, credencial ou dado de contas é publicado. Não execute código extraído manualmente ignorando as permissões do JumpCode.

## Fontes e desenvolvimento

As implementações oficiais vivem em `tools/<id>/src`, com testes independentes em `tools/<id>/tests`. O JumpCode contém somente o carregador/host; instalar um pacote preserva os IDs e os arquivos de Studios existentes. Editar as fontes aqui não altera uma versão já publicada.

Requisitos: Windows x64, Python 3.13 e Node.js 24. O empacotador usa a biblioteca padrão do Node e não precisa de npm install.

```powershell
python scripts/test.py
node --test build/jumpcode-tools/packaging.test.ts
node scripts/check-release.mjs
node build/jumpcode-tools/cli.ts pack tools/webstudio --out webstudio.jctool
```

`check-release.mjs` reproduz os oito arquivos da versão 1.0.1 e compara tamanho e SHA-256 com `release/v1.0.1.json`. O conteúdo dos pacotes é byte a byte igual ao da release assinada. `.gitattributes` preserva os finais de linha dos arquivos usados no empacotamento.

Alguns testes exigem motores opcionais: Node/Python para funções do CloudStudio; o teste real de 3D exige `JUMPCODE_GENERATOR3D_ENGINE`. Eles informam explicitamente quando são pulados. As interfaces também têm testes de navegador em `tools/webstudio/tests/test-browser.cjs` e `tools/archstudio/tests/test-browser.cjs`.

O contrato de pacotes está em `contract/tool-package.ts`: cópia do contrato 1 do host, mantida em conjunto com ele. O formato, a assinatura e a publicação estão documentados em [tools/PACOTES.md](tools/PACOTES.md). Para qualquer alteração no conteúdo de um pacote, aumente sua versão, execute os testes, revise capacidades e dados de Studio, gere e assine os novos metadados fora do servidor. Não substitua bytes de versões publicadas. GitHub hospeda os arquivos; a VPS mantém catálogo, assinaturas atuais e revogações.

As fontes vieram do repositório JumpCode, revisão base `9261277076f4b302f002a5d528a0b64fd9824258`, incluindo a atualização de manifesto para 1.0.1 já publicada. Licenças e avisos de terceiros permanecem nas respectivas pastas. Nenhuma chave de assinatura privada faz parte deste repositório.
