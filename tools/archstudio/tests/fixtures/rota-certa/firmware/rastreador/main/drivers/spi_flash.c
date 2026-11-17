#include "driver/spi_master.h"

#include "spi_flash.h"

int spi_flash_gravar(const char *dados, size_t tamanho)
{
    return tamanho > 0 ? 0 : -1;
}

int spi_flash_ler(char *destino, size_t tamanho)
{
    return 0;
}
