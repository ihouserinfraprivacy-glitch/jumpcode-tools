#include "driver/i2c.h"

#include "i2c_sensores.h"

#define ENDERECO_BME280 0x76

void i2c_sensores_iniciar(void)
{
    i2c_config_t configuracao = { .mode = I2C_MODE_MASTER, .sda_io_num = 8, .scl_io_num = 9 };
    i2c_param_config(I2C_NUM_0, &configuracao);
}

float i2c_sensores_temperatura(void)
{
    uint8_t dados[3] = {0};
    i2c_master_read_from_device(I2C_NUM_0, ENDERECO_BME280, dados, sizeof(dados), 100);
    return dados[0] / 2.0f;
}
