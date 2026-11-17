#pragma once

#include <stddef.h>

int spi_flash_gravar(const char *dados, size_t tamanho);
int spi_flash_ler(char *destino, size_t tamanho);
