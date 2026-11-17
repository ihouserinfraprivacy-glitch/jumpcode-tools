#include "fila_offline.h"
#include "../drivers/spi_flash.h"

void fila_offline_guardar(const char *carga, size_t tamanho)
{
    spi_flash_gravar(carga, tamanho);
}
